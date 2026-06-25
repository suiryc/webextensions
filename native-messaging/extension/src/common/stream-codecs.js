'use strict';

import * as util from './util.js';


// Exhaustive list of registered codecs:
//  https://dvb.org/?standard=dvb-mpeg-dash-profile-for-transport-of-iso-bmff-based-dvb-services-over-ip-based-networks
// (as of 2026-06-25)
//  https://dvb.org/wp-content/uploads/2024/12/A168r9_MPEG-DASH-Profile-for-Transport-of-ISO-BMFF-Based-DVB-Services_Interim-Draft-ts_103-285-v151_May_2025.pdf
//  https://www.etsi.org/deliver/etsi_ts/103200_103299/103285/01.04.01_60/ts_103285v010401p.pdf
//
// Other sources of information:
//  https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/codecs_parameter
//  https://webcodecsfundamentals.org/datasets/codec-support-table/
//  https://www.hbbtv.org/registry-of-video-codecs/
//  https://dashif.org/codecs/audio/
//  https://developers.google.com/cast/docs/media
//  https://www.reddit.com/r/youtubedl/comments/uxzhca/codec_comparison_quality_size_compatibility_etc/

export const STREAM_KIND_UNKNOWN = 'unknown';
export const STREAM_KIND_AUDIO = '🔊';
export const STREAM_KIND_VIDEO = '🎞️';
export const STREAM_KIND_SUBTITLES = '💬';

// Mpeg audio details
// ------------------
// See https://mp4ra.org/registered-types/object-types for object types.
const MP4_OBJECT_TYPE = {
  '40': 'AAC',
  '69': 'mp3',
  '6B': 'mp3',
  'AD': 'opus'
};
const MP4_AUDIO_OBJECT_TYPE = {
  1: 'AAC',
  2: 'AAC-LC',
  3: 'AAC-SSR',
  5: 'HE-AAC',
  29: 'HE-AAC v2',
  42: 'xHE-AAC'
};

// AVC/H264 details
// ----------------
// Codec information contains a 'profile', 'constraints' and 'level' encoded as
// hexadecimal.
// See https://en.wikipedia.org/wiki/Advanced_Video_Coding#Profiles for profiles.
const AVC_PROFILE_KIND = {
  66: 'baseline',
  77: 'main',
  88: 'extended',
  100: 'high',
  110: 'high10',
  122: 'high422',
  244: 'high444'
};

// HEVC/H265 details
// -----------------
// Codec information contains a 'profile', 'level' and 'constraints'.
// Profile is composed of an optional space (spec version), value and
// compatibility.
// See https://en.wikipedia.org/wiki/High_Efficiency_Video_Coding#Profiles for
// list of profiles.
// See https://www.itu.int/rec/T-REC-H.265/en for technical details.
// See https://chromium.googlesource.com/chromium/src/media/+/master/formats/mp4/hevc.cc
// for some live examples.
// We only care for the two mainly used profiles.
const HEVC_PROFILE = {
  '1': 'main',
  '2': 'main10'
};

const VVC_PROFILE = {
  '1': 'main'
};

// AV1 details
// -----------
// Codec information contains a 'profile', 'level', 'tier', 'bit depth', ...
// See https://aomediacodec.github.io/av1-isobmff/#codecsparam for details.
const AV1_PROFILE = {
  '0': 'main',
  '1': 'high',
  '2': 'pro'
};

export class StreamCodec {

  static parse(raw, kind) {
    if (!kind) kind = STREAM_KIND_UNKNOWN;

    const [codec, ...variant] = (raw || '').split('.');
    const parser = codecParser[codec.toLowerCase()];
    if (!parser) return new StreamCodec(raw, kind);

    return parser(raw, kind, codec, variant.join('.'));
  }

  static parseKindNoop(kind) {
    return function(raw, unused, codec, variant) {
      return StreamCodec.parseNoop(raw, kind, codec, variant);
    };
  }

  static parseNoop(raw, kind, codec, variant) {
    return new StreamCodec(raw, kind, codec.toLowerCase());
  }

  static parseMP4A(raw, kind, codec, variant) {
    // Expected format: OO[.A]
    //  OO: object type
    //  A: audio object type
    const split = (variant || '').split('.');
    const otype = MP4_OBJECT_TYPE[split[0].toUpperCase()];
    if (!otype) return new StreamCodec(raw, STREAM_KIND_AUDIO, 'MP4A');

    if ((otype !== 'AAC') || (split.length === 1)) return new StreamCodec(raw, STREAM_KIND_AUDIO, otype);

    const atype = MP4_AUDIO_OBJECT_TYPE[parseInt(split[1])];
    if (!atype) return new StreamCodec(raw, STREAM_KIND_AUDIO, otype);
    return new StreamCodec(raw, STREAM_KIND_AUDIO, atype);
  }

  static parseVP8(raw, kind, codec, variant) {
    return new StreamCodec(raw, STREAM_KIND_VIDEO, 'VP8');
  }

  static parseVP9(raw, kind, codec, variant) {
    // We don't care about profiles/levels here.
    return new StreamCodec(raw, STREAM_KIND_VIDEO, 'VP9');
  }

  static parseAVC(raw, kind, codec, variant) {
    const details = ['H264'];

    // Expected format: XXYYZZ (hexadecimal)
    //  XX: profile
    //  YY: constraints
    //  ZZ: level; where 'a.b' is computed as 'a * 10 + b'
    if ((variant || '').length === 6) {
      const profile = AVC_PROFILE_KIND[util.parseHex(variant.slice(0, 2))];
      if (profile) details.push(profile);

      const level = util.parseHex(variant.slice(4));
      details.push(`${Math.round(level / 10)}.${level % 10}`);
    }

    return new StreamCodec(raw, STREAM_KIND_VIDEO, details.join(' '));
  }

  static parseHEVC(raw, kind, codec, variant) {
    const details = ['H265'];

    // Expected format: X.X.Y.Z[.Z.Z]
    //  X.X: profile
    //  Y: level; tier followed by 'a.b' computed as '3*(a * 10 + b)'.
    //  Z: constraints
    const split = (variant || '').split('.');
    if (split.length >= 4) {
      let profile = split[0];
      // We don't care about the profile space.
      let char = profile[0];
      if ((char < '0') || (char > '9')) profile = profile.slice(1);
      profile = HEVC_PROFILE[profile];
      if (profile) details.push(profile);

      let level = split[2];
      // We don't care about the level tier.
      char = level[0];
      if ((char < '0') || (char > '9')) level = level.slice(1);
      details.push(`${Math.round(level / 30)}.${Math.round((level % 30) / 3)}`);
    }

    return new StreamCodec(raw, STREAM_KIND_VIDEO, details.join(' '));
  }

  static parseVVC(raw, kind, codec, variant) {
    const details = ['H266'];

    // Expected format: X.Y.Z[...]
    //  X: profile
    //  Y: level followed by tier; 'a.b' computed as 'a * 16 + b * 3'
    const split = (variant || '').split('.');
    if (split.length >= 3) {
      const profile = VVC_PROFILE[split[0]];
      if (profile) details.push(profile);

      let level = split[1];
      // We don't care about the level tier.
      const char = level[0];
      if ((char < '0') || (char > '9')) level = level.slice(1);
      details.push(`${Math.round(level / 16)}.${Math.round((level % 16) / 3)}`);
    }

    return new StreamCodec(raw, STREAM_KIND_VIDEO, details.join(' '));
  }

  static parseAV1(raw, kind, codec, variant) {
    const details = ['AV1'];

    // Expected format: P.LLT.DD[.M.CCC.cp.tc.mc.F]
    // Level 'a.b' is computed as 'LL' so that 'a = 2 + LL >> 2' and 'b = LL & 3'.
    const split = (variant || '').split('.');
    if (split.length >= 3) {
      let profile = AV1_PROFILE[split[0]];
      if (profile) {
        const depth = parseInt(split[2]);
        if (depth) profile += depth;
        details.push(profile);
      }

      const level = parseInt(split[1].slice(0, 2));
      details.push(`${2 + (level >> 2)}.${level & 3}`);
    }

    return new StreamCodec(raw, STREAM_KIND_VIDEO, details.join(' '));
  }

  constructor(raw, kind, details) {
    this.raw = raw;
    this.kind = kind;
    this.details = details;
  }

  desc() {
    if (this.kind === STREAM_KIND_UNKNOWN) return this.raw;
    return `${this.kind}${this.details || ''} (${this.raw})`;
  }

}

const codecParser = {
  'av01': StreamCodec.parseAV1,
  'mp4a': StreamCodec.parseMP4A
};

['mp3', 'vorbis', 'flac', 'opus'].forEach(c => {
  codecParser[c] = StreamCodec.parseKindNoop(STREAM_KIND_AUDIO);
});

['vp8', 'vp08'].forEach(c => {
  codecParser[c] = StreamCodec.parseVP8;
});

['vp9', 'vp09'].forEach(c => {
  codecParser[c] = StreamCodec.parseVP9;
});

[1, 2, 3, 4].forEach(v => {
  codecParser[`avc${v}`] = StreamCodec.parseAVC;
});

['hev1', 'hvc1'].forEach(c => {
  codecParser[c] = StreamCodec.parseHEVC;
});

['vvc1', 'vvci'].forEach(c => {
  codecParser[c] = StreamCodec.parseVVC;
});
