'use strict';

// Define dummy classes not existing in Node.js.
if (!('Event' in global)) global.Event = class {};
if (!('Element' in global)) global.Element = class {};
if (!('Document' in global)) global.Document = class {};
if (!('XMLHttpRequest' in global)) global.XMLHttpRequest = class {};

import * as assert from 'assert';
import * as util from '../common/util.js';


describe('util', function() {

  function testCloning(cloningF) {
    function test(v, expected) {
      if (expected === undefined) expected = v;
      assert.deepEqual(cloningF(v), expected);
    }

    it('should handle primitive values', function() {
      test(undefined);
      test(null);
      test(true);
      test(false);
      test(0);
      test(1);
      test(-1);
      test(1.234);
      test('');
      test('Some Value');
    });

    it('should handle arrays', function() {
      test([]);
      test([undefined, null, true, 1, 'value']);
    });

    it('should handle objects', function() {
      test({});
      test({
        u: undefined,
        n: null,
        b: true,
        i: 1,
        f: 1.234,
        s: 'value'
      });
    });

    it('should handle recursion', function() {
      test([undefined, null, [true, [1, {
        a: [{
          o: {
            b: true
          }
        }]
      }], {}], 'value']);
      test({
        u: undefined,
        n: null,
        o: {
          b: true,
          i: 1,
          f: 1.234,
          s: 'value',
          a: [-1, 'other', [], {}, {b: false}]
        }
      });
    });

    it('should ignore functions', function() {
      assert.deepEqual(cloningF(test), undefined);
      test([test], [undefined]);
      test({
        f: test
      }, {});
      test({
        f: test,
        s: 'value'
      }, {s: 'value'});
      test([test, 1, test, {
        f: test
      }, {
        f: test,
        s: 'value'
      }], [undefined, 1, undefined, {}, {s: 'value'}]);
    });
  }

  describe('tryStructuredClone', function() {

    testCloning(util.tryStructuredClone);

    it('should clone circular recursion', function() {
      // Prepare data with multiple circular recursion.
      let obj = {};
      obj.circularObj = obj;
      obj.recursion = {
        circularObj: obj
      };
      let arr = [];
      arr.push(obj);
      arr.push(arr);
      arr.push([arr, obj]);
      obj.arr = arr;
      obj.recursion.arr = arr;

      let testCircular = function() {
        let r = util.tryStructuredClone(arr);
        // Delete the offending field if any.
        delete(obj['f']);
        // Clone content should be equal.
        assert.deepEqual(r, arr);
        // Cloned array should not be original.
        assert.notStrictEqual(r, arr);
        // Nor cloned object.
        assert.notStrictEqual(r[0], arr[0]);
        // Array clones should be strictly equal.
        assert.strictEqual(r, r[1]);
        assert.strictEqual(r, r[2][0]);
        assert.strictEqual(r, r[0].arr);
        assert.strictEqual(r, r[0].recursion.arr);
        // Object clones should be strictly equal.
        assert.strictEqual(r[0], r[0].circularObj);
        assert.strictEqual(r[0], r[0].recursion.circularObj);
        assert.strictEqual(r[0], r[1][0]);
        assert.strictEqual(r[0], r[2][1]);
      }
      // Structured clone will work on this data, and handles circual recursion.
      testCircular();
      // So do a second test that will trigger our recursion handling, to ensure
      // we properly clone circular recursion too.
      obj.f = testCircular;
      testCircular();

      // Now do the same when root is an object instead of array.
      testCircular = function() {
        let r = util.tryStructuredClone(obj);
        // Delete the offending field if any.
        delete(obj['f']);
        // Clone content should be equal.
        assert.deepEqual(r, obj);
        // Cloned object should not be original.
        assert.notStrictEqual(r, obj);
        // Nor cloned array.
        assert.notStrictEqual(r.arr, arr);
        // Object clones should be strictly equal.
        assert.strictEqual(r, r.circularObj);
        assert.strictEqual(r, r.recursion.circularObj);
        assert.strictEqual(r, r.arr[0]);
        assert.strictEqual(r, r.arr[2][1]);
        // Array clones should be strictly equal.
        assert.strictEqual(r.arr, r.recursion.arr);
        assert.strictEqual(r.arr, r.arr[1]);
        assert.strictEqual(r.arr, r.arr[2][0]);
      }
      testCircular();
      obj.f = testCircular;
      testCircular();
    });

  });

  describe('toJSON', function() {

    testCloning(util.toJSON);

    it('should use object.toJSON when present', function() {
      let obj1 = {
        b: true,
        s: 'value'
      };
      let obj2 ={
        b: false,
        s: 'other value',
        i: -1
      };
      assert.deepEqual(util.toJSON(obj1), obj1);
      obj1.toJSON = function() {
        return obj2;
      };
      assert.deepEqual(util.toJSON(obj1), obj2);
    });

    it('should break circular recursion', function() {
      // Prepare data with multiple circular recursion.
      let obj = {};
      obj.circularObj = obj;
      obj.recursion = {
        circularObj: obj
      };
      // Duplicate reference to an object at the same level.
      obj.recursion2 = obj.recursion;
      let arr = [];
      arr.push(obj);
      arr.push(arr);
      arr.push([arr, obj]);
      // Duplicate reference to an object at the same level.
      arr.push(obj);
      obj.arr = arr;
      obj.recursion.arr = arr;

      let expectedObj = {};
      expectedObj.circularObj = undefined;
      expectedObj.recursion = {
        circularObj: undefined
      };
      expectedObj.recursion2 = expectedObj.recursion;
      let expectedArr = [];
      expectedArr.push(expectedObj);
      expectedArr.push(undefined);
      expectedArr.push([undefined, expectedObj]);
      expectedArr.push(expectedObj);
      expectedObj.arr = undefined;
      expectedObj.recursion.arr = undefined;
      assert.deepEqual(util.toJSON(arr), expectedArr);

      expectedArr = [];
      expectedArr.push(undefined);
      expectedArr.push(undefined);
      expectedArr.push([undefined, undefined]);
      expectedArr.push(undefined);
      expectedObj.arr = expectedArr;
      expectedObj.recursion.arr = expectedArr;
      assert.deepEqual(util.toJSON(obj), expectedObj);
    });

  });

  describe('formatObject', function() {

    it('should handle primitive values', function() {
      assert.strictEqual(util.formatObject(true), 'true');
      assert.strictEqual(util.formatObject(false), 'false');
      assert.strictEqual(util.formatObject(0), '0');
      assert.strictEqual(util.formatObject(1), '1');
      assert.strictEqual(util.formatObject(-1), '-1');
      assert.strictEqual(util.formatObject(1.234), '1.234');
    });

    it('should quote strings', function() {
      assert.strictEqual(util.formatObject('ab cd'), '"ab cd"');
      assert.strictEqual(util.formatObject(''), '""');
    });

    it('should handle undefined value', function() {
      assert.strictEqual(util.formatObject(undefined), 'undefined');
    });

    it('should handle null value', function() {
      assert.strictEqual(util.formatObject(null), 'null');
    });

    it('should handle functions', function() {
      assert.strictEqual(util.formatObject(function fname() {}), 'function fname');
      assert.strictEqual(util.formatObject(() => {}), 'function (anonymous)');
    });

    it('should handle arrays', function() {
      assert.strictEqual(util.formatObject([true, 0, '']), '[ true, 0, "" ]');
    });

    it('should handle plain object', function() {
      assert.strictEqual(util.formatObject({a: false, b: 0, c: ''}), 'Object a=<false> b=<0> c=<"">');
    });

    it('should handle class instance', function() {
      class A {
        constructor() {
          this.a = false;
          this.b = 0;
          this.c = '';
        }
      };
      assert.strictEqual(util.formatObject(new A()), 'A a=<false> b=<0> c=<"">');
    });

    it('should handle object with toString', function() {
      assert.strictEqual(util.formatObject({toString: () => 'object string'}), 'object string');
    });

    it('should handle Error', function() {
      assert.strictEqual(util.formatObject(new Error('error message')), 'Error message=<error message>');
    });

    it('should handle complex object', function() {
      class A {
        constructor() {
          this.a = [false, 0, '', {a: false, b: [1]}];
        }
      };
      assert.strictEqual(util.formatObject(new A()), 'A a=<[ false, 0, "", Object a=<false> b=<[ 1 ]> ]>');
    });

    it('should detect recursion and circular recursion object', function() {
      let a = {};
      a.b = {};
      a.b.c = {};
      a.b.c.d = a;
      a.b.c.e = a.b;
      assert.strictEqual(util.formatObject(a), 'Object b=<Object c=<Object d=<(recursive) Object> e=<(recursive) Object>>>');

      let b = [];
      let c = {b};
      b.push(b);
      b.push([b]);
      b.push(c);
      b.push(c);
      assert.strictEqual(util.formatObject(b), '[ (recursive) Array(4), [ (recursive) Array(4) ], Object b=<(recursive) Array(4)>, Object b=<(recursive) Array(4)> ]');
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
      let f1 = () => {};
      let f2 = () => {};
      let f3 = function () {};

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
      let obj = {
        a: 0,
        b: '',
        c: false,
        d: undefined,
        e: null,
        f: {},
        g: []
      };
      let expected = {
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

  describe('urlString', function() {

    it('should leave value as-is when applicable', function() {
      assert.strictEqual(util.urlString(undefined), undefined);
      assert.strictEqual(util.urlString(null), null);
      assert.strictEqual(util.urlString(''), '');
      // The function is not meant to validate URLs, only stringify them.
      assert.strictEqual(util.urlString('whatever'), 'whatever');
    });

    it('should convert to string when needed', function() {
      assert.strictEqual(util.urlString(new URL('http://site/path/file')), 'http://site/path/file');
      assert.strictEqual(util.urlString(new Object()), '[object Object]');
    });

  });

  describe('parseSiteUrl', function() {

    it('should handle full URL', function() {
      let url = 'https://www.sitename.tld/path/subpath/file.ext?param=value#fragment';
      assert.deepStrictEqual(
        util.parseSiteUrl(url),
        {
          url: (new URL(url)).href,
          hostname: 'www.sitename.tld',
          pathParts: ['path', 'subpath', 'file.ext'],
          name: 'sitename',
          nameParts: ['www', 'sitename', 'tld']
        }
      );
    });

    it('should handle minimal URL', function() {
      let url = 'https://sitename';
      assert.deepStrictEqual(
        util.parseSiteUrl(url),
        {
          url: (new URL(url)).href,
          hostname: 'sitename',
          pathParts: [],
          name: 'sitename',
          nameParts: ['sitename']
        }
      );
    });

    it('should handle an URL object', function() {
      let url = new URL('https://www.sitename.tld/path/subpath/file.ext?param=value#fragment');
      assert.deepStrictEqual(
        util.parseSiteUrl(url),
        {
          url: url.href,
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
      assert.strictEqual(util.getFilename(undefined), '');
      assert.strictEqual(util.getFilename(null), '');
      assert.strictEqual(util.getFilename(''), '');
    });

    it('should handle proper url', function() {
      assert.strictEqual(util.getFilename('http://server'), '');
      assert.strictEqual(util.getFilename('http://server:port'), '');
      assert.strictEqual(util.getFilename('http://server/'), '');
      assert.equal(util.getFilename('http://server/path'), 'path');
      assert.equal(util.getFilename('http://server/path/sub'), 'sub');
      assert.equal(util.getFilename('http://server/path/sub/file.ext'), 'file.ext');
    });

    it('should handle url decoding', function() {
      assert.equal(util.getFilename('http://server/file%E2%82%AC.ext'), 'file€.ext');
      assert.equal(util.getFilename('http://server/%3C%23%3Epath%E2%82%AC/%3C%23%3Esub%E2%82%AC/%3C%23%3Efile%E2%82%AC.ext'), '<#>file€.ext');
    });

    it('should handle explicit filename', function() {
      // Test bad URLs (fail to parse).
      [undefined, null, '', 'http://server', 'http://server:port', 'http://server/', 'http://server/file%E2%AC.ext'].forEach(url => {
        // Test empty filenames.
        [undefined, null, ''].forEach(filename => {
          assert.strictEqual(util.getFilename(undefined, filename), '');
          assert.strictEqual(util.getFilename(url, filename), '');
        });
      });
      // URL shall be ignored if filename is present.
      assert.equal(util.getFilename(undefined, '0'), '0');
      assert.equal(util.getFilename('http://server/file.ext', '0'), '0');
    });

    it('should trim filename', function() {
      assert.equal(util.getFilename('http://server/path/sub/  \t  file.ext  \r\n'), 'file.ext');
      assert.equal(util.getFilename('http://server/file.ext', '    \t  0  \r\n'), '0');
      assert.equal(util.getFilename('http://server/file.ext', '    \t   \r\n'), 'file.ext');
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
      assert.strictEqual(util.buildFilename(undefined), '');
      assert.strictEqual(util.buildFilename(null), '');
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

  describe('filenameWithExtension', function() {

    it('should build proper filename', function() {
      assert.strictEqual(util.filenameWithExtension(undefined, 'ext'), undefined);
      assert.strictEqual(util.filenameWithExtension(null, 'ext'), null);
      assert.strictEqual(util.filenameWithExtension('filename', undefined), 'filename');
      assert.strictEqual(util.filenameWithExtension('filename', null), 'filename');
      assert.strictEqual(util.filenameWithExtension('filename', ''), 'filename');
      assert.equal(util.filenameWithExtension('filename', 'ext'), 'filename.ext');
      assert.equal(util.filenameWithExtension('filename.ext', 'other'), 'filename.other');
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
      assert.strictEqual(util.limitText(undefined, 128), undefined);
      assert.strictEqual(util.limitText(null, 128), null);
      assert.strictEqual(util.limitText('', 128), '');
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
