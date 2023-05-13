'use strict';

// Define dummy classes not existing in Node.js.
if (!('Event' in global)) global.Event = class {};
if (!('XMLHttpRequest' in global)) global.XMLHttpRequest = class {};

import * as assert from 'assert';
import * as util from '../common/util.js';


describe('util', function() {

  describe('formatObject', function() {

    it('should handle primitive values', function() {
      assert.equal(util.formatObject(true), 'true');
      assert.equal(util.formatObject(false), 'false');
      assert.equal(util.formatObject(0), '0');
      assert.equal(util.formatObject(1), '1');
      assert.equal(util.formatObject(-1), '-1');
      assert.equal(util.formatObject(1.234), '1.234');
    });

    it('should quote strings', function() {
      assert.equal(util.formatObject('ab cd'), '"ab cd"');
      assert.equal(util.formatObject(''), '""');
    });

    it('should handle undefined value', function() {
      assert.equal(util.formatObject(undefined), 'undefined');
    });

    it('should handle null value', function() {
      assert.equal(util.formatObject(null), 'null');
    });

    it('should handle functions', function() {
      assert.equal(util.formatObject(function fname() {}), 'function fname');
      assert.equal(util.formatObject(() => {}), 'function (anonymous)');
    });

    it('should handle arrays', function() {
      assert.equal(util.formatObject([true, 0, '']), '[ true, 0, "" ]');
    });

    it('should handle plain object', function() {
      assert.equal(util.formatObject({a: false, b: 0, c: ''}), 'Object a=<false> b=<0> c=<"">');
    });

    it('should handle class instance', function() {
      class A {
        constructor() {
          this.a = false;
          this.b = 0;
          this.c = '';
        }
      };
      assert.equal(util.formatObject(new A()), 'A a=<false> b=<0> c=<"">');
    });

    it('should handle object with toString', function() {
      assert.equal(util.formatObject({toString: () => 'object string'}), 'object string');
    });

    it('should handle Error', function() {
      assert.equal(util.formatObject(new Error('error message')), 'Error message=<error message>');
    });

    it('should handle complex object', function() {
      class A {
        constructor() {
          this.a = [false, 0, '', {a: false, b: [1]}];
        }
      };
      assert.equal(util.formatObject(new A()), 'A a=<[ false, 0, "", Object a=<false> b=<[ 1 ]> ]>');
    });

    it('should detect resursive object', function() {
      var a = {};
      a.b = {};
      a.b.c = {};
      a.b.c.d = a;
      a.b.c.e = a.b;
      assert.equal(util.formatObject(a), 'Object b=<Object c=<Object d=<(recursive) Object> e=<(recursive) Object>>>');
    });

  });

  describe('deepEqual', function() {

    it('should handle primitive values', function() {
      assert.equal(util.deepEqual(false, false), true);
      assert.equal(util.deepEqual(true, true), true);
      assert.equal(util.deepEqual(0, 0), true);
      assert.equal(util.deepEqual(0, -0), true);
      assert.equal(util.deepEqual(1, 1), true);
      assert.equal(util.deepEqual(-1, -1), true);
      assert.equal(util.deepEqual(1.234, 1.234), true);

      assert.equal(util.deepEqual(false, true), false);
      assert.equal(util.deepEqual(true, false), false);
      assert.equal(util.deepEqual(0, 1), false);
      assert.equal(util.deepEqual(1, -1), false);
      assert.equal(util.deepEqual(1.234, 1.2345), false);
    });

    it('should handle strings', function() {
      assert.equal(util.deepEqual('a', 'a'), true);
      assert.equal(util.deepEqual('', ''), true);

      assert.equal(util.deepEqual('a', 'b'), false);
      assert.equal(util.deepEqual('', 'a'), false);
      assert.equal(util.deepEqual('a', ''), false);
      assert.equal(util.deepEqual(false, ''), false);
      assert.equal(util.deepEqual(0, ''), false);
    });

    it('should handle undefined value', function() {
      assert.equal(util.deepEqual(undefined, undefined), true);

      assert.equal(util.deepEqual(false, undefined), false);
      assert.equal(util.deepEqual(undefined, false), false);
      assert.equal(util.deepEqual(0, undefined), false);
      assert.equal(util.deepEqual(undefined, 0), false);
      assert.equal(util.deepEqual('', undefined), false);
      assert.equal(util.deepEqual(undefined, ''), false);
    });

    it('should handle null value', function() {
      assert.equal(util.deepEqual(null, null), true);

      assert.equal(util.deepEqual(undefined, null), false);
      assert.equal(util.deepEqual(null, undefined), false);
      assert.equal(util.deepEqual(false, null), false);
      assert.equal(util.deepEqual(null, false), false);
      assert.equal(util.deepEqual(0, null), false);
      assert.equal(util.deepEqual(null, 0), false);
      assert.equal(util.deepEqual('', null), false);
      assert.equal(util.deepEqual(null, ''), false);
    });

    it('should handle functions', function() {
      var f1 = () => {};
      var f2 = () => {};
      var f3 = function () {};

      assert.equal(util.deepEqual(f1, f1), true);
      assert.equal(util.deepEqual(f2, f2), true);
      assert.equal(util.deepEqual(f3, f3), true);

      assert.equal(util.deepEqual(f1, f2), false);
      assert.equal(util.deepEqual(f2, f3), false);
    });

    it('should handle arrays', function() {
      assert.equal(util.deepEqual([], []), true);
      assert.equal(util.deepEqual([false], [false]), true);
      assert.equal(util.deepEqual([1, false, 'a'], [1, false, 'a']), true);

      assert.equal(util.deepEqual([], [false]), false);
      assert.equal(util.deepEqual([false], [true]), false);
      assert.equal(util.deepEqual([1, false, 'a'], [1, false, 'b']), false);
    });

    it('should handle objects', function() {
      assert.equal(util.deepEqual({}, {}), true);
      assert.equal(util.deepEqual({a: false}, {a: false}), true);
      assert.equal(util.deepEqual({a: 1, b: false, c: 'a'}, {a: 1, b: false, c:'a'}), true);

      assert.equal(util.deepEqual({}, {a: undefined}), false);
      assert.equal(util.deepEqual({a: false}, {a: true}), false);
      assert.equal(util.deepEqual({a: 1, b: false, c: 'a'}, {a: 1, b: false, c:'b'}), false);
    });

    it('should handle complex objects', function() {
      assert.equal(util.deepEqual({a: false, b: {c: {d: 'a'}, d: 0}}, {a: false, b: {c: {d: 'a'}, d: 0}}), true);
      assert.equal(util.deepEqual({a: false, b: {c: {d: 'a'}, d: 0}}, {a: false, b: {c: {d: 'b'}, d: 0}}), false);
    });

  });

  describe('cleanupFields', function() {

    it('should remove undefined and null fields', function() {
      var obj = {
        a: 0,
        b: '',
        c: false,
        d: undefined,
        e: null,
        f: {},
        g: []
      };
      var expected = {
        a: 0,
        b: '',
        c: false,
        f: {},
        g: []
      };
      util.cleanupFields(obj);
      assert.deepEqual(obj, expected);
    });

  });

  describe('parseSiteUrl', function() {

    it('should handle full URL', function() {
      var url = 'https://www.sitename.tld/path/subpath/file.ext?param=value#fragment';
      assert.deepStrictEqual(
        util.parseSiteUrl(url),
        {
          url: new URL(url),
          hostname: 'www.sitename.tld',
          pathParts: ['path', 'subpath', 'file.ext'],
          name: 'sitename',
          nameParts: ['www', 'sitename', 'tld']
        }
      );
    });

    it('should handle minimal URL', function() {
      var url = 'https://sitename';
      assert.deepStrictEqual(
        util.parseSiteUrl(url),
        {
          url: new URL(url),
          hostname: 'sitename',
          pathParts: [],
          name: 'sitename',
          nameParts: ['sitename']
        }
      );
    });

    it('should handle an URL object', function() {
      var url = new URL('https://www.sitename.tld/path/subpath/file.ext?param=value#fragment');
      assert.deepStrictEqual(
        util.parseSiteUrl(url),
        {
          url: url,
          hostname: 'www.sitename.tld',
          pathParts: ['path', 'subpath', 'file.ext'],
          name: 'sitename',
          nameParts: ['www', 'sitename', 'tld']
        }
      );
    });

  });

  describe('getFilename', function() {

    it('should handle falsy value', function() {
      assert.equal(util.getFilename(undefined), '');
      assert.equal(util.getFilename(null), '');
      assert.equal(util.getFilename(''), '');
    });

    it('should handle proper url', function() {
      assert.equal(util.getFilename('http://server'), '');
      assert.equal(util.getFilename('http://server:port'), '');
      assert.equal(util.getFilename('http://server/'), '');
      assert.equal(util.getFilename('http://server/path'), 'path');
      assert.equal(util.getFilename('http://server/path/sub'), 'sub');
      assert.equal(util.getFilename('http://server/path/sub/file.ext'), 'file.ext');
    });

    it('should handle url decoding', function() {
      assert.equal(util.getFilename('http://server/file%E2%82%AC.ext'), 'file€.ext');
      assert.equal(util.getFilename('http://server/%3C%23%3Epath%E2%82%AC/%3C%23%3Esub%E2%82%AC/%3C%23%3Efile%E2%82%AC.ext'), '<#>file€.ext');
    });

    it('should handle filename fallback', function() {
      [undefined, null, '', 'http://server', 'http://server:port', 'http://server/', 'http://server/file%E2%AC.ext'].forEach(url => {
        [undefined, null, ''].forEach(filename => {
          assert.equal(util.getFilename(undefined, filename), '');
        });
        assert.equal(util.getFilename(undefined, '0'), '0');
      });
    });

  });

  describe('getFilenameExtension', function() {

    it('should handle falsy value', function() {
      assert.deepEqual(util.getFilenameExtension(undefined), {name: '', extension: ''});
      assert.deepEqual(util.getFilenameExtension(null), {name: '', extension: ''});
      assert.deepEqual(util.getFilenameExtension(''), {name: '', extension: ''});
    });

    it('should handle filename with extension', function() {
      assert.deepEqual(util.getFilenameExtension('file.ext'), {name: 'file', extension: 'ext'});
      assert.deepEqual(util.getFilenameExtension('file.name.ext'), {name: 'file.name', extension: 'ext'});
      assert.deepEqual(util.getFilenameExtension('.file.ext'), {name: '.file', extension: 'ext'});
    });

    it('should handle filename without extension', function() {
      assert.deepEqual(util.getFilenameExtension('filename'), {name: 'filename', extension: ''});
      assert.deepEqual(util.getFilenameExtension('.filename'), {name: '.filename', extension: ''});
    });

    it('should handle default extension', function() {
      [undefined, null, '', 'filename', '.filename'].forEach(filename => {
        [undefined, null, ''].forEach(defaultExtension => {
          assert.deepEqual(util.getFilenameExtension(filename, defaultExtension), {name: filename || '', extension: ''});
        });
        assert.deepEqual(util.getFilenameExtension(filename, 'ext'), {name: filename || '', extension: 'ext'});
      });
      assert.deepEqual(util.getFilenameExtension('file.other', 'ext'), {name: 'file', extension: 'other'});
      assert.deepEqual(util.getFilenameExtension('file.name.other', 'ext'), {name: 'file.name', extension: 'other'});
    });

  });

  describe('buildFilename', function() {

    it('should build proper filename', function() {
      assert.equal(util.buildFilename(undefined), '');
      assert.equal(util.buildFilename(null), '');
      assert.equal(util.buildFilename('file'), 'file');
      assert.equal(util.buildFilename('file', undefined), 'file');
      assert.equal(util.buildFilename('file', null), 'file');
      assert.equal(util.buildFilename('file', ''), 'file');
      assert.equal(util.buildFilename('file.name', undefined), 'file.name');
      assert.equal(util.buildFilename('file.name', null), 'file.name');
      assert.equal(util.buildFilename('file.name', ''), 'file.name');
      assert.equal(util.buildFilename('.file'), '.file');
      assert.equal(util.buildFilename('.file.name', ''), '.file.name');
      assert.equal(util.buildFilename(undefined, 'ext'), '.ext');
      assert.equal(util.buildFilename(null, 'ext'), '.ext');
      assert.equal(util.buildFilename('file', 'ext'), 'file.ext');
      assert.equal(util.buildFilename('file.name', 'ext'), 'file.name.ext');
    });

  });

  describe('roundNumber', function() {

    it('should round number', function() {
      assert.equal(util.roundNumber(0.), 0.);
      assert.equal(util.roundNumber(0., 3, 3), 0.);
      // Note: use a not too big value to prevent any number precision rouding.
      // e.g. '123456789.123456789' would not give the exact expected result.
      // Testing number of decimals
      assert.equal(util.roundNumber(1234.123456789, 9), 1234.123456789);
      assert.equal(util.roundNumber(1234.123456789, 8), 1234.12345679);
      assert.equal(util.roundNumber(1234.123456789, 1), 1234.1);
      // Testing default precision of 3
      assert.equal(util.roundNumber(1234.123456789), 1234);
      assert.equal(util.roundNumber(123.123456789), 123);
      assert.equal(util.roundNumber(12.123456789), 12.1);
      assert.equal(util.roundNumber(1.123456789), 1.12);
      assert.equal(util.roundNumber(0.123456789), 0.123);
      // Testing precision
      assert.equal(util.roundNumber(1234.123456789, undefined, 13), 1234.123456789);
      assert.equal(util.roundNumber(1234.123456789, undefined, 12), 1234.12345679);
      assert.equal(util.roundNumber(1234.123456789, undefined, 5), 1234.1);
      assert.equal(util.roundNumber(1234.123456789, undefined, 4), 1234);
      assert.equal(util.roundNumber(1234.123456789, undefined, 3), 1234);
      assert.equal(util.roundNumber(1234.123456789, undefined, 0), 1234);
    });

  });

  describe('padNumber', function() {

    it('should pad number if necessary', function() {
      assert.equal(util.padNumber(0, 4), '0000');
      assert.equal(util.padNumber(1, 4), '0001');
      assert.equal(util.padNumber(12, 4), '0012');
      assert.equal(util.padNumber(123, 4), '0123');
    });

    it('should not pad number if not necessary', function() {
      assert.equal(util.padNumber(0, 0), '0');
      assert.equal(util.padNumber(0, 1), '0');
      assert.equal(util.padNumber(1, 0), '1');
      assert.equal(util.padNumber(1, 1), '1');
      assert.equal(util.padNumber(1234, 4), '1234');
      assert.equal(util.padNumber(123456789, 4), '123456789');
    });

  });

  describe('getSizeText', function() {

    it('should give human-readbable representation of bytes size', function() {
      assert.equal(util.getSizeText(0), '0B');
      assert.equal(util.getSizeText(1023), '1023B');
      assert.equal(util.getSizeText(1024), '1K');
      assert.equal(util.getSizeText(1025), '1K');
      assert.equal(util.getSizeText(1536), '1.5K');
      assert.equal(util.getSizeText(2047), '2K');
      assert.equal(util.getSizeText(2048), '2K');
      // Handle K, M, G, T
      assert.equal(util.getSizeText(Math.pow(1024, 2)), '1M');
      assert.equal(util.getSizeText(Math.pow(1024, 3)), '1G');
      assert.equal(util.getSizeText(Math.pow(1024, 4)), '1T');
      assert.equal(util.getSizeText(Math.pow(1024, 5)), '1024T');
      // 3 digits of precision
      assert.equal(util.getSizeText(1.005 * Math.pow(1024, 2)), '1M');
      assert.equal(util.getSizeText(1.005 * Math.pow(1024, 2) + 1), '1.01M');
    });

  });

  describe('limitText', function() {

    it('should truncate the middle of text depending on size', function() {
      assert.equal(util.limitText(undefined, 128), undefined);
      assert.equal(util.limitText(null, 128), null);
      assert.equal(util.limitText('', 128), '');
      assert.equal(util.limitText('abcdef', 6), 'abcdef');
      assert.equal(util.limitText('abcdef', 5), 'ab…ef');
      assert.equal(util.limitText('abcdef', 4), 'ab…f');
      assert.equal(util.limitText('abcdef', 3), 'a…f');
      assert.equal(util.limitText('abcdef', 2), 'a…');
      assert.equal(util.limitText('abcdef', 1), '…');
      assert.equal(util.limitText('abcde', 5), 'abcde');
      assert.equal(util.limitText('abcde', 4), 'ab…e');
      assert.equal(util.limitText('abcde', 3), 'a…e');
      assert.equal(util.limitText('abcde', 2), 'a…');
      assert.equal(util.limitText('abcde', 1), '…');
    });

  });

});
