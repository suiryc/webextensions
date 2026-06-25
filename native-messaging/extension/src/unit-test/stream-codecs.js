'use strict';

import * as assert from 'assert';
import * as codecs from '../common/stream-codecs.js';


describe('StreamCodec', function() {

  const codecsInfo = {
    // Unknown codecs
    '': {
      'codec': new codecs.StreamCodec('', codecs.STREAM_KIND_UNKNOWN),
      'desc': ''
    },
    'rawvalue': {
      'codec': new codecs.StreamCodec('rawvalue', codecs.STREAM_KIND_UNKNOWN),
      'desc': 'rawvalue'
    },
    'raw.value': {
      'codec': new codecs.StreamCodec('raw.value', codecs.STREAM_KIND_UNKNOWN),
      'desc': 'raw.value'
    }
  };

  function addCodec(raw, kind, desc) {
    codecsInfo[raw] = {
      'codec': new codecs.StreamCodec(raw, kind, desc),
      'desc': `${kind}${desc} (${raw})`
    };
  }

  // VP8/VP9
  addCodec('vp8', codecs.STREAM_KIND_VIDEO, 'VP8');
  addCodec('vp08', codecs.STREAM_KIND_VIDEO, 'VP8');
  addCodec('vp9', codecs.STREAM_KIND_VIDEO, 'VP9');
  addCodec('vp09', codecs.STREAM_KIND_VIDEO, 'VP9');
  addCodec('vp09.XX', codecs.STREAM_KIND_VIDEO, 'VP9');

  // H264 semi-exhaustive (no SVC) list
  const h264Profiles = {
    '42': 'baseline',
    '4D': 'main',
    '58': 'extended',
    '64': 'high',
    '6E': 'high10',
    '7A': 'high422',
    'F4': 'high444'
  };
  // We don't care about constraints
  const h264Constraints = ['00', '40', 'E0', 'XX'];
  const h264Levels = {
    '0A': '1.0',
    '0B': '1.1',
    '0C': '1.2',
    '0D': '1.3',
    '14': '2.0',
    '15': '2.1',
    '16': '2.2',
    '1E': '3.0',
    '1F': '3.1',
    '20': '3.2',
    '28': '4.0',
    '29': '4.1',
    '2A': '4.2',
    '32': '5.0',
    '33': '5.1',
    '34': '5.2',
    '3C': '6.0',
    '3D': '6.1',
    '3E': '6.2'
  };
  for (const [profileV, profileName] of Object.entries(h264Profiles)) {
    for (const constraint of h264Constraints) {
      for (const [levelV, levelName] of Object.entries(h264Levels)) {
        const info = `avc1.${profileV}${constraint}${levelV}`;
        const details = `H264 ${profileName} ${levelName}`;
        addCodec(info, codecs.STREAM_KIND_VIDEO, details);
      }
    }
  }
  // Alternative 'avc2-4' name, and lowercase hexadecimal.
  addCodec('avc2.42E01E', codecs.STREAM_KIND_VIDEO, 'H264 baseline 3.0');
  addCodec('avc3.42e01e', codecs.STREAM_KIND_VIDEO, 'H264 baseline 3.0');
  addCodec('avc4.42e01e', codecs.STREAM_KIND_VIDEO, 'H264 baseline 3.0');
  // Unknown profile
  addCodec('avc3.000032', codecs.STREAM_KIND_VIDEO, 'H264 5.0');
  // Invalid profile/constraints
  addCodec('avc3.XXXX32', codecs.STREAM_KIND_VIDEO, 'H264 5.0');
  // Alternative without details.
  addCodec('avc1', codecs.STREAM_KIND_VIDEO, 'H264');

  // H265
  // We don't care about profile space.
  const h265ProfileSpaces = ['', 'A', 'B', 'C'];
  const h265Profiles = {
    '1': 'main',
    '2': 'main10'
  };
  // We don't care about profile compatibility.
  const h265ProfileCompatibilities = ['0', '4', '6'];
  const h265Levels = {
    '30': '1.0',
    '60': '2.0',
    '63': '2.1',
    '90': '3.0',
    '93': '3.1',
    '120': '4.0',
    '123': '4.1',
    '150': '5.0',
    '153': '5.1',
    '156': '5.2',
    '180': '6.0',
    '183': '6.1',
    '186': '6.2'
  };
  // We don't care about constraints
  const h265Constraints = ['00', 'B0', 'XX.XX'];
  for (const profileSpace of h265ProfileSpaces) {
    for (const [profileV, profileName] of Object.entries(h265Profiles)) {
      for (const profileCompatilibity of h265ProfileCompatibilities) {
        for (const [levelV, levelName] of Object.entries(h265Levels)) {
          for (const constraint of h265Constraints) {
            const info = `hev1.${profileSpace}${profileV}.${profileCompatilibity}.${levelV}.${constraint}`;
            const details = `H265 ${profileName} ${levelName}`;
            addCodec(info, codecs.STREAM_KIND_VIDEO, details);
          }
        }
      }
    }
  }
  // Alternative 'avc2-4' name.
  addCodec('hvc1.1.6.H90.B0', codecs.STREAM_KIND_VIDEO, 'H265 main 3.0');
  // Unknown profile
  addCodec('hev1.3.0.L150.B0', codecs.STREAM_KIND_VIDEO, 'H265 5.0');
  // Alternative without details.
  addCodec('hev1', codecs.STREAM_KIND_VIDEO, 'H265');

  // H266
  const h266Profiles = {
    '1': 'main'
  };
  // We don't care about level tier.
  const h266LevelTiers = ['', 'L'];
  const h266Levels = {
    '16': '1.0',
    '32': '2.0',
    '35': '2.1',
    '48': '3.0',
    '51': '3.1',
    '64': '4.0',
    '67': '4.1',
    '80': '5.0',
    '83': '5.1',
    '87': '5.2',
    '96': '6.0',
    '99': '6.1',
    '102': '6.2'
  };
  // We don't care about extra details.
  const h266Extra = ['.CQA', '.CQA.O0+3'];
  for (const [profileV, profileName] of Object.entries(h266Profiles)) {
    for (const [levelV, levelName] of Object.entries(h266Levels)) {
      for (const levelTier of h266LevelTiers) {
        for (const extra of h266Extra) {
          const info = `vvc1.${profileV}.${levelTier}${levelV}${extra}`;
          const details = `H266 ${profileName} ${levelName}`;
          addCodec(info, codecs.STREAM_KIND_VIDEO, details);
        }
      }
    }
  }
  // Alternative 'vvci' name.
  addCodec('vvci.1.H48.B0', codecs.STREAM_KIND_VIDEO, 'H266 main 3.0');
  // Unknown profile
  addCodec('vvc1.2.L80.CQA', codecs.STREAM_KIND_VIDEO, 'H266 5.0');
  // Alternative without details.
  addCodec('vvc1', codecs.STREAM_KIND_VIDEO, 'H266');

  // AV1
  const av1Profiles = {
    '0': 'main',
    '1': 'high',
    '2': 'pro'
  };
  const av1Levels = {
    '0': '2.0',
    '1': '2.1',
    '2': '2.2',
    '3': '2.3',
    '4': '3.0',
    '5': '3.1',
    '6': '3.2',
    '7': '3.3',
    '8': '4.0',
    '9': '4.1',
    '10': '4.2',
    '11': '4.3',
    '12': '5.0',
    '13': '5.1',
    '14': '5.2',
    '15': '5.3',
    '16': '6.0',
    '17': '6.1',
    '18': '6.2',
    '19': '6.3',
    '20': '7.0',
    '21': '7.1',
    '22': '7.2',
    '23': '7.3'
  };
  // We don't care about level tier.
  const av1LevelTiers = ['M', 'H'];
  const av1Depths = {
    '08': 8,
    '10': 10,
    '12': 12
  };
  // We don't care about extra details.
  const av1Extra = ['', '.XX', '.0.100.09.16.09.0'];
  for (const [profileV, profileName] of Object.entries(av1Profiles)) {
    for (const [levelV, levelName] of Object.entries(av1Levels)) {
      for (const levelTier of av1LevelTiers) {
        for (const [depthV, depthName] of Object.entries(av1Depths)) {
          for (const extra of av1Extra) {
            const info = `av01.${profileV}.${levelV}${levelTier}.${depthV}${extra}`;
            const details = `AV1 ${profileName}${depthName} ${levelName}`;
            addCodec(info, codecs.STREAM_KIND_VIDEO, details);
          }
        }
      }
    }
  }
  // Unknown profile
  addCodec('av01.3.12H.08', codecs.STREAM_KIND_VIDEO, 'AV1 5.0');
  // Invalid depth.
  addCodec('av01.0.12H.XX', codecs.STREAM_KIND_VIDEO, 'AV1 main 5.0');
  // Alternative without details.
  addCodec('av01', codecs.STREAM_KIND_VIDEO, 'AV1');

  // Simple audio codecs.
  ['mp3', 'vorbis', 'flac', 'opus'].forEach(c => {
    addCodec(c, codecs.STREAM_KIND_AUDIO, c.toLowerCase());
  });

  // MP4A non-AAC
  addCodec('mp4a.69', codecs.STREAM_KIND_AUDIO, 'mp3');
  addCodec('mp4a.6B', codecs.STREAM_KIND_AUDIO, 'mp3');
  addCodec('mp4a.ad', codecs.STREAM_KIND_AUDIO, 'opus');
  // Unknown/non-specified MP4A.
  addCodec('mp4a', codecs.STREAM_KIND_AUDIO, 'MP4A');
  addCodec('mp4a.0', codecs.STREAM_KIND_AUDIO, 'MP4A');

  // AAC
  const aacAudioTypes = {
    1: 'AAC',
    2: 'AAC-LC',
    3: 'AAC-SSR',
    5: 'HE-AAC',
    29: 'HE-AAC v2',
    42: 'xHE-AAC'
  };
  for (const [audioV, audioName] of Object.entries(aacAudioTypes)) {
    const info = `mp4a.40.${audioV}`;
    addCodec(info, codecs.STREAM_KIND_AUDIO, audioName);
  }
  // Unknown AAC audio type.
  addCodec('mp4a.40.0', codecs.STREAM_KIND_AUDIO, 'AAC');
  // Two-digit audio type.
  addCodec('mp4a.40.05', codecs.STREAM_KIND_AUDIO, 'HE-AAC');
  // AAC without details.
  addCodec('mp4a.40', codecs.STREAM_KIND_AUDIO, 'AAC');


  it('should parse codec information', function() {
    assert.deepEqual(codecs.StreamCodec.parse(), new codecs.StreamCodec(undefined, codecs.STREAM_KIND_UNKNOWN));
    for (const [s, expected] of Object.entries(codecsInfo)) {
      assert.deepEqual(codecs.StreamCodec.parse(s), expected.codec);
    }
    assert.deepEqual(codecs.StreamCodec.parse('rawvalue'), new codecs.StreamCodec('rawvalue', codecs.STREAM_KIND_UNKNOWN));
  });

  it('should give codec description', function() {
    assert.strictEqual(codecs.StreamCodec.parse().desc(), undefined);
    for (const [s, expected] of Object.entries(codecsInfo)) {
      assert.strictEqual(codecs.StreamCodec.parse(s).desc(), expected.desc);
    }
  });

});
