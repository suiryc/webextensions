'use strict';

import * as assert from 'assert';
import * as util from '../common/util.js';
import * as hls from '../background/stream-hls.js';


describe('hls', function() {

  describe('HLSTagParser', function() {

    it('should parse tag without value nor attributes', function() {
      assert.deepEqual(hls.HLSPlaylist.parseTag('#some-tag'), {
        name: 'some-tag',
        value: '',
        attributes: {}
      });
      assert.deepEqual(hls.HLSPlaylist.parseTag('#some-tag:'), {
        name: 'some-tag',
        value: '',
        attributes: {}
      });
      assert.deepEqual(hls.HLSPlaylist.parseTag('#some-tag:,'), {
        name: 'some-tag',
        value: '',
        attributes: {}
      });
    });

    it('should parse tag with value and without attributes', function() {
      assert.deepEqual(hls.HLSPlaylist.parseTag('#some-tag:value'), {
        name: 'some-tag',
        value: 'value',
        attributes: {}
      });
      assert.deepEqual(hls.HLSPlaylist.parseTag('#some-tag:value,'), {
        name: 'some-tag',
        value: 'value',
        attributes: {}
      });
    });

    it('should parse tag without value and with attributes', function() {
      assert.deepEqual(hls.HLSPlaylist.parseTag('#some-tag:att1=value1'), {
        name: 'some-tag',
        value: '',
        attributes: {
          att1: 'value1'
        }
      });
      assert.deepEqual(hls.HLSPlaylist.parseTag('#some-tag:,att1=value1,'), {
        name: 'some-tag',
        value: '',
        attributes: {
          att1: 'value1'
        }
      });
      assert.deepEqual(hls.HLSPlaylist.parseTag('#some-tag:att-1=value1,att-2=value2'), {
        name: 'some-tag',
        value: '',
        attributes: {
          'att-1': 'value1',
          'att-2': 'value2'
        }
      });
    });

    it('should parse tag with value and attributes', function() {
      assert.deepEqual(hls.HLSPlaylist.parseTag('#some-tag:value,att-1=value1,att-2=value2'), {
        name: 'some-tag',
        value: 'value',
        attributes: {
          'att-1': 'value1',
          'att-2': 'value2'
        }
      });
    });

    it('should parse know value kinds or consider as string', function() {
      assert.deepEqual(hls.HLSPlaylist.parseTag('#some-tag:"value",att-1="value1"'), {
        name: 'some-tag',
        value: 'value',
        attributes: {
          'att-1': "value1"
        }
      });
      assert.deepEqual(hls.HLSPlaylist.parseTag('#EXT-X-STREAM-INF:BANDWIDTH=123456,RESOLUTION=1920x1080,FRAME-RATE=23.976'), {
        name: 'EXT-X-STREAM-INF',
        value: '',
        attributes: {
          BANDWIDTH: 123456,
          RESOLUTION: {
            width: 1920,
            height: 1080
          },
          'FRAME-RATE': 23.976
        }
      });
    });

    it('should cope with invalid values', function() {
      assert.deepEqual(hls.HLSPlaylist.parseTag('#EXT-X-STREAM-INF:BANDWIDTH=123a456,AVERAGE-BANDWIDTH=123.456,RESOLUTION=1920x1080a,FRAME-RATE="23.976"'), {
        name: 'EXT-X-STREAM-INF',
        value: '',
        attributes: {
          BANDWIDTH: 0,
          'AVERAGE-BANDWIDTH': 0,
          RESOLUTION: {
            width: 1920,
            height: 0
          },
          'FRAME-RATE': 0
        }
      });
      assert.deepEqual(hls.HLSPlaylist.parseTag('#EXT-X-STREAM-INF:RESOLUTION=1080'), {
        name: 'EXT-X-STREAM-INF',
        value: '',
        attributes: {
          RESOLUTION: {
            width: 0,
            height: 0
          }
        }
      });
    });

  });

  const RAW_MASTER_EX1 = `
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000,AVERAGE-BANDWIDTH=1000000,NAME="low"
http://example.com/low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2560000,AVERAGE-BANDWIDTH=2000000,RESOLUTION=1280x720
http://example.com/mid.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=7680000,AVERAGE-BANDWIDTH=6000000
http://example.com/hi.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=65000,CODECS="mp4a.40.5"
http://example.com/audio-only.m3u8
`;

  const RAW_MASTER_EX2 = `
#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group",NAME="",DEFAULT=YES,AUTOSELECT=YES,URI="https://example.com/full-path/audio.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group",NAME="",DEFAULT=NO,AUTOSELECT=YES,URI="/absolute-path/audio.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group",NAME="",DEFAULT=NO,AUTOSELECT=YES,URI="relative-path/audio.m3u8"
#EXT-X-STREAM-INF:NAME="1",AUDIO="group"
https://example.com/full-path/stream.m3u8
#EXT-X-STREAM-INF:NAME="2",AUDIO="group"
/absolute-path/stream.m3u8
#EXT-X-STREAM-INF:NAME="3",AUDIO="group"
relative-path/stream.m3u8
`;

  const RAW_STREAM_EX1 = `
#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-VERSION:3
#EXTINF:9.009,
http://media.example.com/first.ts
#EXTINF:9.009,
http://media.example.com/second.ts
#EXTINF:3.003,
http://media.example.com/third.ts
#EXT-X-ENDLIST
`;
  const TAGS_STREAM_EX1 = {
    'EXT-X-TARGETDURATION': [{
      name: 'EXT-X-TARGETDURATION',
      value: 10,
      attributes: {}
    }],
    'EXT-X-VERSION': [{
      name: 'EXT-X-VERSION',
      value: 3,
      attributes: {}
    }],
    'EXTINF': [{
      name: 'EXTINF',
      value: 9.009,
      attributes: {},
      uri: 'http://media.example.com/first.ts'
    }, {
      name: 'EXTINF',
      value: 9.009,
      attributes: {},
      uri: 'http://media.example.com/second.ts'
    }, {
      name: 'EXTINF',
      value: 3.003,
      attributes: {},
      uri: 'http://media.example.com/third.ts'
    }],
    'EXT-X-ENDLIST': [{
      name: 'EXT-X-ENDLIST',
      value: '',
      attributes: {}
    }]
  };

  describe('HLSPlaylist', function() {

    it('should ignore non-HLS content', function() {
      let playlist = new hls.HLSPlaylist('');
      assert.deepEqual(playlist.tags, {});

      playlist = new hls.HLSPlaylist(`


  `);
      assert.deepEqual(playlist.tags, {});
      playlist = new hls.HLSPlaylist(`
  #whatever
  #EXTM3U
  `);
      assert.deepEqual(playlist.tags, {});
    });

    it('should parse HLS content', function() {
      let playlist = new hls.HLSPlaylist(RAW_STREAM_EX1);
      assert.deepEqual(playlist.tags, TAGS_STREAM_EX1);
      assert.deepEqual(playlist.streams, []);

      // Notes:
      // Test streams without renditions, and name either:
      //  - explicit
      //  - derived from resolution
      //  - derived from average bandwidth
      //  - derived from bandwidth
      playlist = new hls.HLSPlaylist(RAW_MASTER_EX1);
      assert.deepEqual(playlist.tags, {
        'EXT-X-STREAM-INF': [{
          name: 'EXT-X-STREAM-INF',
          value: '',
          attributes: {
            BANDWIDTH: 1280000,
            'AVERAGE-BANDWIDTH': 1000000,
            NAME: 'low'
          },
          uri: 'http://example.com/low.m3u8'
        }, {
          name: 'EXT-X-STREAM-INF',
          value: '',
          attributes: {
            BANDWIDTH: 2560000,
            'AVERAGE-BANDWIDTH': 2000000,
            RESOLUTION: {
              width: 1280,
              height: 720
            }
          },
          uri: 'http://example.com/mid.m3u8'
        }, {
          name: 'EXT-X-STREAM-INF',
          value: '',
          attributes: {
            BANDWIDTH: 7680000,
            'AVERAGE-BANDWIDTH': 6000000
          },
          uri: 'http://example.com/hi.m3u8'
        }, {
          name: 'EXT-X-STREAM-INF',
          value: '',
          attributes: {
            BANDWIDTH: 65000,
            CODECS: 'mp4a.40.5'
          },
          uri: 'http://example.com/audio-only.m3u8'
        }]
      });
      let buildStream = function(idx, name) {
        let tag = playlist.tags['EXT-X-STREAM-INF'][idx];
        return {
          tag,
          tags: {},
          uri: tag.uri,
          name,
          video: [],
          audio: [],
          subtitles: []
        };
      };
      assert.deepEqual(util.tryStructuredClone(playlist.streams).map(s => {
        delete(s['playlist']);
        return s;
      }), [
        buildStream(0, 'low'),
        buildStream(1, '720p'),
        buildStream(2, '≈5.72Mbps'),
        buildStream(3, '≤63.5Kbps')
      ]);

      playlist = new hls.HLSPlaylist(`
#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="en",URI="main/english-audio.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Deutsch",DEFAULT=NO,AUTOSELECT=YES,LANGUAGE="de",URI="main/german-audio.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Commentary",DEFAULT=NO,AUTOSELECT=NO,LANGUAGE="en",URI="commentary/audio-only.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1280000,CODECS="...",AUDIO="aac"
low/video-only.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2560000,CODECS="...",AUDIO="aac"
mid/video-only.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=7680000,CODECS="...",AUDIO="aac"
hi/video-only.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=65000,CODECS="mp4a.40.5",AUDIO="aac"
main/english-audio.m3u8
`);
      assert.deepEqual(playlist.tags, {
        'EXT-X-MEDIA': [{
          name: 'EXT-X-MEDIA',
          value: '',
          attributes: {
            TYPE: 'AUDIO',
            'GROUP-ID': 'aac',
            NAME: 'English',
            DEFAULT: true,
            AUTOSELECT: true,
            LANGUAGE: 'en',
            URI: 'main/english-audio.m3u8'
          }
        }, {
          name: 'EXT-X-MEDIA',
          value: '',
          attributes: {
            TYPE: 'AUDIO',
            'GROUP-ID': 'aac',
            NAME: 'Deutsch',
            DEFAULT: false,
            AUTOSELECT: true,
            LANGUAGE: 'de',
            URI: 'main/german-audio.m3u8'
          }
        }, {
          name: 'EXT-X-MEDIA',
          value: '',
          attributes: {
            TYPE: 'AUDIO',
            'GROUP-ID': 'aac',
            NAME: 'Commentary',
            DEFAULT: false,
            AUTOSELECT: false,
            LANGUAGE: 'en',
            URI: 'commentary/audio-only.m3u8'
          }
        }],
        'EXT-X-STREAM-INF': [{
          name: 'EXT-X-STREAM-INF',
          value: '',
          attributes: {
            BANDWIDTH: 1280000,
            CODECS: '...',
            AUDIO: 'aac'
          },
          uri: 'low/video-only.m3u8'
        }, {
          name: 'EXT-X-STREAM-INF',
          value: '',
          attributes: {
            BANDWIDTH: 2560000,
            CODECS: '...',
            AUDIO: 'aac'
          },
          uri: 'mid/video-only.m3u8'
        }, {
          name: 'EXT-X-STREAM-INF',
          value: '',
          attributes: {
            BANDWIDTH: 7680000,
            CODECS: '...',
            AUDIO: 'aac'
          },
          uri: 'hi/video-only.m3u8'
        }, {
          name: 'EXT-X-STREAM-INF',
          value: '',
          attributes: {
            BANDWIDTH: 65000,
            CODECS: 'mp4a.40.5',
            AUDIO: 'aac'
          },
          uri: 'main/english-audio.m3u8'
        }]
      });
      let buildTrack = function(tag) {
        return {
          tag,
          uri: tag.attributes['URI'],
          lang: tag.attributes['LANGUAGE'],
          name: tag.attributes['NAME'] || tag.attributes['LANGUAGE']
        };
      };
      buildStream = function(idx, name) {
        let tag = playlist.tags['EXT-X-STREAM-INF'][idx];
        return {
          tag,
          tags: {},
          uri: tag.uri,
          name,
          video: [],
          audio: [
            buildTrack(playlist.tags['EXT-X-MEDIA'][0]),
            buildTrack(playlist.tags['EXT-X-MEDIA'][1]),
            buildTrack(playlist.tags['EXT-X-MEDIA'][2])
          ],
          subtitles: []
        };
      };
      assert.deepEqual(util.tryStructuredClone(playlist.streams).map(s => {
        delete(s['playlist']);
        for (let track of s.audio) {
          delete(track['stream']);
        }
        return s;
      }), [
        buildStream(0, '≤1.22Mbps'),
        buildStream(1, '≤2.44Mbps'),
        buildStream(2, '≤7.32Mbps'),
        buildStream(3, '≤63.5Kbps')
      ]);
    });

    it('should handle playlist URI', function() {
      let playlist = new hls.HLSPlaylist(RAW_MASTER_EX2, {url: 'https://domain.net'});
      assert.strictEqual(playlist.streams[0].getURL().href, 'https://example.com/full-path/stream.m3u8');
      assert.strictEqual(playlist.streams[1].getURL().href, 'https://domain.net/absolute-path/stream.m3u8');
      assert.strictEqual(playlist.streams[2].getURL().href, 'https://domain.net/relative-path/stream.m3u8');
      for (let stream of playlist.streams) {
        assert.strictEqual(stream.audio[0].getURL().href, 'https://example.com/full-path/audio.m3u8');
        assert.strictEqual(stream.audio[1].getURL().href, 'https://domain.net/absolute-path/audio.m3u8');
        assert.strictEqual(stream.audio[2].getURL().href, 'https://domain.net/relative-path/audio.m3u8');
      }

      playlist = new hls.HLSPlaylist(RAW_MASTER_EX2, {url: 'https://domain.net/some/subpath'});
      assert.strictEqual(playlist.streams[0].getURL().href, 'https://example.com/full-path/stream.m3u8');
      assert.strictEqual(playlist.streams[1].getURL().href, 'https://domain.net/absolute-path/stream.m3u8');
      assert.strictEqual(playlist.streams[2].getURL().href, 'https://domain.net/some/relative-path/stream.m3u8');
      for (let stream of playlist.streams) {
        assert.strictEqual(stream.audio[0].getURL().href, 'https://example.com/full-path/audio.m3u8');
        assert.strictEqual(stream.audio[1].getURL().href, 'https://domain.net/absolute-path/audio.m3u8');
        assert.strictEqual(stream.audio[2].getURL().href, 'https://domain.net/some/relative-path/audio.m3u8');
      }

      playlist = new hls.HLSPlaylist(RAW_MASTER_EX2, {url: 'https://domain.net/some/subpath/'});
      assert.strictEqual(playlist.streams[0].getURL().href, 'https://example.com/full-path/stream.m3u8');
      assert.strictEqual(playlist.streams[1].getURL().href, 'https://domain.net/absolute-path/stream.m3u8');
      assert.strictEqual(playlist.streams[2].getURL().href, 'https://domain.net/some/subpath/relative-path/stream.m3u8');
      for (let stream of playlist.streams) {
        assert.strictEqual(stream.audio[0].getURL().href, 'https://example.com/full-path/audio.m3u8');
        assert.strictEqual(stream.audio[1].getURL().href, 'https://domain.net/absolute-path/audio.m3u8');
        assert.strictEqual(stream.audio[2].getURL().href, 'https://domain.net/some/subpath/relative-path/audio.m3u8');
      }
    });

    it('should handle tags', function() {
      let playlist = new hls.HLSPlaylist(RAW_STREAM_EX1);
      assert.deepEqual(playlist.getTag('EXTINF'), TAGS_STREAM_EX1['EXTINF'][0]);
      assert.deepEqual(playlist.getTags('EXTINF'), TAGS_STREAM_EX1['EXTINF']);
    });

    it('should handle unknown tags', function() {
      let playlist = new hls.HLSPlaylist(`
#EXTM3U
#EXT-UNKNOWN:BANDWIDTH=123456,RESOLUTION=1920x1080,FRAME-RATE=23.976
`);
      assert.deepEqual(playlist.tags, {
        'EXT-UNKNOWN': [{
          name: 'EXT-UNKNOWN',
          value: '',
          attributes: {
            BANDWIDTH: '123456',
            RESOLUTION: '1920x1080',
            'FRAME-RATE': '23.976'
          }
        }]
      });
    });

    it('should handle comma in quoted string', function() {
      let playlist = new hls.HLSPlaylist(`
#EXTM3U
#EXT-UNKNOWN:NAME="v1,v2",BANDWIDTH=123456,RESOLUTION=1920x1080,FRAME-RATE=23.976
#EXT-UNKNOWN:NAME="v1,v2"extra
#EXT-UNKNOWN:NAME="v1,v2" extra ,K=V
#EXT-UNKNOWN:"v1,v2"
#EXT-UNKNOWN:"v1,v2"extra
#EXT-UNKNOWN:"v1,v2" extra ,K=V
#EXT-X-STREAM-INF:BANDWIDTH=2560000,CODECS="c1,c2"
file.m3u8
`);
      assert.deepEqual(playlist.tags, {
        'EXT-UNKNOWN': [{
          name: 'EXT-UNKNOWN',
          value: '',
          attributes: {
            NAME: 'v1,v2',
            BANDWIDTH: '123456',
            RESOLUTION: '1920x1080',
            'FRAME-RATE': '23.976'
          }
        }, {
          name: 'EXT-UNKNOWN',
          value: '',
          attributes: {
            NAME: 'v1,v2'
          }
        }, {
          name: 'EXT-UNKNOWN',
          value: '',
          attributes: {
            NAME: 'v1,v2',
            K: 'V'
          }
        }, {
          name: 'EXT-UNKNOWN',
          value: 'v1,v2',
          attributes: {}
        }, {
          name: 'EXT-UNKNOWN',
          value: 'v1,v2',
          attributes: {}
        }, {
          name: 'EXT-UNKNOWN',
          value: 'v1,v2',
          attributes: {
            K: 'V'
          }
        }],
        'EXT-X-STREAM-INF': [{
          name: 'EXT-X-STREAM-INF',
          value: '',
          attributes: {
            BANDWIDTH: 2560000,
            CODECS: 'c1,c2'
          },
          uri: 'file.m3u8'
        }]
      });
    });

    it('should handle non-value tags', function() {
      let playlist = new hls.HLSPlaylist(`
#EXTM3U
#EXT-UNKNOWN:K=V,K2,K3
`);
      assert.deepEqual(playlist.tags, {
        'EXT-UNKNOWN': [{
          name: 'EXT-UNKNOWN',
          value: '',
          attributes: {
            K: 'V',
            K2: '',
            K3: ''
          }
        }]
      });
    });

    it('should ignore comments and unexpected non-tag lines', function() {
      let playlist = new hls.HLSPlaylist(`
# some comment
#EXTM3U
some-value
# some comment
some-value
#EXT-UNKNOWN
some-value
#EXTINF:3.003,
some-url
some-value
# some comment
some-value
`);
      assert.deepEqual(playlist.tags, {
        'EXT-UNKNOWN': [{
          name: 'EXT-UNKNOWN',
          value: '',
          attributes: {}
        }],
        'EXTINF': [{
          name: 'EXTINF',
          value: 3.003,
          attributes: {},
          uri: 'some-url'
        }]
      });
    });

    it('should handle being a stream playlist', function() {
      let playlist = new hls.HLSPlaylist('');
      assert.strictEqual(playlist.isStream(), undefined);

      playlist = new hls.HLSPlaylist(RAW_MASTER_EX1);
      assert.strictEqual(playlist.isStream(), undefined);

      playlist = new hls.HLSPlaylist(RAW_STREAM_EX1, {url: 'https://domain.net/some/file.m3u8'});
      let stream = playlist.isStream();
      assert.deepEqual(stream, {
        raw: RAW_STREAM_EX1,
        tags: TAGS_STREAM_EX1,
        uri: 'https://domain.net/some/file.m3u8',
        name: 'file',
        duration: 21.021,
        video: [],
        audio: [],
        subtitles: []
      });
      assert.equal(stream.getURL(), 'https://domain.net/some/file.m3u8');
      assert.deepEqual(stream.getTag('EXTINF'), TAGS_STREAM_EX1['EXTINF'][0]);
      assert.deepEqual(stream.getTags('EXTINF'), TAGS_STREAM_EX1['EXTINF']);
    });

  });

  describe('HLSStream', function() {

    it('should handle being assigned actual stream', function() {
      let playlist = new hls.HLSPlaylist(RAW_MASTER_EX1);
      let stream = playlist.streams[0];
      let actualStream = new hls.HLSPlaylist(RAW_STREAM_EX1, {url: 'https://domain.net/some/file.m3u8'}).isStream();
      stream.merge(actualStream);
      delete(stream.playlist);
      assert.deepEqual(stream, {
        tag: {
          name: 'EXT-X-STREAM-INF',
          value: '',
          attributes: {
            BANDWIDTH: 1280000,
            'AVERAGE-BANDWIDTH': 1000000,
            NAME: 'low'
          },
          uri: 'http://example.com/low.m3u8'
        },
        raw: RAW_STREAM_EX1,
        tags: TAGS_STREAM_EX1,
        uri: 'http://example.com/low.m3u8',
        name: 'low',
        duration: 21.021,
        size: 2627625,
        sizeQualifier: '≈',
        video: [],
        audio: [],
        subtitles: []
      });

      stream = playlist.streams[3];
      actualStream = new hls.HLSPlaylist(RAW_STREAM_EX1, {url: 'https://domain.net/some/file.m3u8'}).isStream();
      stream.merge(actualStream);
      delete(stream.playlist);
      assert.deepEqual(stream, {
        tag: {
          name: 'EXT-X-STREAM-INF',
          value: '',
          attributes: {
            BANDWIDTH: 65000,
            CODECS: 'mp4a.40.5'
          },
          uri: 'http://example.com/audio-only.m3u8'
        },
        raw: RAW_STREAM_EX1,
        tags: TAGS_STREAM_EX1,
        uri: 'http://example.com/audio-only.m3u8',
        name: '≤63.5Kbps',
        duration: 21.021,
        size: 170796,
        sizeQualifier: '≤',
        video: [],
        audio: [],
        subtitles: []
      });
    });

    it('should handle keys', function() {
      let stream = new hls.HLSPlaylist(`
#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-VERSION:3
#EXT-X-KEY:METHOD=AES-128,URI=relative/key.bin
#EXTINF:9.009,
http://media.example.com/first.ts
#EXT-X-KEY:METHOD=NONE,URI=whatever
#EXTINF:9.009,
http://media.example.com/second.ts
#EXT-X-KEY:METHOD=AES-128,URI=https://other.net/absolute/key.bin
#EXTINF:3.003,
http://media.example.com/third.ts
#EXT-X-ENDLIST
`, {url: 'https://domain.net/some/file.m3u8'}).isStream();
      assert.deepEqual(stream.getKeys(), [{
        method: 'AES-128',
        url: 'https://domain.net/some/relative/key.bin'
      }, {
        method: 'NONE',
        url: undefined
      }, {
        method: 'AES-128',
        url: 'https://other.net/absolute/key.bin'
      }]);
    });

  });

});
