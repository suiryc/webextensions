'use strict';

import * as assert from 'assert';
import * as http from '../common/http.js';


describe('http', function() {

  describe('findHeader/findHeaderValue', function() {

    function test(headers, name, expected) {
      // Test findHeader
      var r = http.findHeader(headers, name);
      r = http.findHeader(headers, name);
      assert.deepEqual(r, expected);
      // Ensure that findHeader returns the original object.
      assert.equal(http.findHeader(headers, name), http.findHeader(headers, name));

      // Test findHeaderValue
      r = http.findHeaderValue(headers, name);
      assert.equal(r, (expected || {}).value);
    }

    it('should find exact header', function() {
      test(
        [{name:'Header1',value:'value1'}, {name:'Header2',value:'value2'}, {name:'Header3',value:'value3'}],
        'Header2', {name:'Header2',value:'value2'}
      );
    });

    it('should find header with different case', function() {
      test(
        [{name:'Header1',value:'value1'}, {name:'Header2',value:'value2'}, {name:'Header3',value:'value3'}],
        'hEADER2', {name:'Header2',value:'value2'}
      );
    });

    it('should find first matching header', function() {
      test(
        [{name:'Header1',value:'value1'}, {name:'Header',value:'value2'}, {name:'Header',value:'value3'}],
        'Header', {name:'Header',value:'value2'}
      );
      test(
        [{name:'Header',value:'value1'}, {name:'Header',value:'value2'}, {name:'Header',value:'value3'}],
        'Header', {name:'Header',value:'value1'}
      );
    });

    it('should not match missing header', function() {
      test(
        [{name:'Header1',value:'value1'}, {name:'Header2',value:'value2'}, {name:'Header3',value:'value3'}],
        'Header', undefined
      );
    });

  });

});

describe('HeaderParser', function() {

  describe('#skipFWS', function() {

    it('should skip any whitespace', function() {
      [' ', '\t', '\r', '\n'].forEach(c => {
        var parser = new http.HeaderParser(`${c}a`);
        assert.equal(parser.skipFWS(), (c != '\n') ? c : ' ');
        assert.equal(parser.value, 'a');
      })
    });

    it('should skip multiple whitespaces', function() {
      var parser = new http.HeaderParser(` \r \t a`);
      assert.equal(parser.skipFWS(), ' \r \t ');
      assert.equal(parser.value, 'a');
      parser = new http.HeaderParser(` \r\n \t a`);
      assert.equal(parser.skipFWS(), ' ');
      assert.equal(parser.value, 'a');
    });

  });

  describe('#parseToken', function() {

    it('should match all token characters', function() {
      var token = "!#$%&'*+-.^_\`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
      '" \r\n\t(),/:;<=>?@[\\]{}]'.split('').forEach(c => {
        var parser = new http.HeaderParser(`${token}${c}`);
        var r = parser.parseToken();
        assert.equal(r, token);
        assert.equal(parser.value, /\s/.test(c) ? '' : c);
      });
    });

    it('should skip whitespaces around token', function() {
      var parser = new http.HeaderParser(' \t a\r\nb');
      var r = parser.parseToken();
      assert.equal(r, 'a');
      assert.equal(parser.value, 'b');
    });

  });

  describe('#skipComment', function() {

    it('should skip comment', function() {
      var parser = new http.HeaderParser('(anything "whatever" \(\))b');
      parser.skipComment();
      assert.equal(parser.value, 'b');
    });

    it('should handle recursive comment', function() {
      var parser = new http.HeaderParser('(anything ("whatever") \(\))b');
      parser.skipComment();
      assert.equal(parser.value, 'b');
    });

    it('should also skip whitespaces around comment', function() {
      var parser = new http.HeaderParser(' \t ()\r\nb');
      parser.skipComment();
      assert.equal(parser.value, 'b');
    });

  });

  describe('#decodeString', function() {

    var parser = new http.HeaderParser('');

    it('should handle plain value', function() {
      var r = parser.decodeString("utf-8'language'value");
      assert.equal(r, 'value');
    });

    it('should handle UTF-8 value', function() {
      var r = parser.decodeString("utf-8'anything'%c2%a3%20and%20%e2%82%ac%20rates");
      assert.equal(r, '£ and € rates');
    });

    it('should ignore language', function() {
      var r = parser.decodeString("utf-8''value");
      assert.equal(r, 'value');
    });

    it('should simply unescape for unknown charset', function() {
      var r = parser.decodeString("anything''%E4%F6%FC");
      assert.equal(r, 'äöü');
    });

    it('should not change non-encoded string', function() {
      var r = parser.decodeString("utf-8");
      assert.equal(r, "utf-8");
      r = parser.decodeString("utf-8'%E4%F6%FC");
      assert.equal(r, "utf-8'%E4%F6%FC");
    });

  });

  describe('#parseParameters', function() {

    it('should handle a token parameter value', function() {
      var parser = new http.HeaderParser(';a=b');
      var r = parser.parseParameters(true);
      assert.deepEqual(r, {a: 'b'});
      assert.equal(parser.value, '');
    });

    it('should handle a quoted string parameter value', function() {
      var parser = new http.HeaderParser(';a="b\\"c');
      var r = parser.parseParameters(true);
      assert.deepEqual(r, {a: 'b"c'});
      assert.equal(parser.value, '');
    });

    it('should handle an encoded parameter value', function() {
      var parser = new http.HeaderParser(`;a*="utf-8''%e2%82%ac"`);
      var r = parser.parseParameters(true);
      assert.deepEqual(r, {a: '€'});
      assert.equal(parser.value, '');
    });

    it('should handle a split parameter value', function() {
      var parser = new http.HeaderParser(`;a*0="b";a*2="c";a*1*="utf-8''%e2%82%ac"`);
      var r = parser.parseParameters(true);
      assert.deepEqual(r, {a: 'b€c'});
      assert.equal(parser.value, '');
    });

    it('should skip whitespaces', function() {
      var parser = new http.HeaderParser(' \t\r\n ; \t\r\n a \t\r\n = \t\r\n b \t\r\n ');
      var r = parser.parseParameters(true);
      assert.deepEqual(r, {a: 'b'});
      assert.equal(parser.value, '');
    });

    it('should skip comments if requested', function() {
      var parser = new http.HeaderParser(' \t\r\n ; \t\r\n a \t\r\n = \t\r\n (( \t\r\n )) \t\r\n b \t\r\n (( ""\t\r\n )) \t\r\n ');
      var r = parser.parseParameters();
      assert.deepEqual(r, {a: 'b'});
      assert.equal(parser.value, '');
    });

    it('should handle multiple parameters', function() {
      var parser = new http.HeaderParser(`;param2*1*="utf-8''%e2%82%ac"; param1=value1; param2*0="b"; param2*2="c"; param3=()""(); param4=0`);
      var r = parser.parseParameters();
      assert.deepEqual(r, {param1: 'value1', param2: 'b€c', param3: '', param4: '0'});
      assert.equal(parser.value, '');
    });

    it('should handle malformed values', function() {
      var parser = new http.HeaderParser('; \t\r\n a \t\r\n = \t\r\n (()) b (("")) \t\r\n ');
      var r = parser.parseParameters(true);
      // The RFC only expects token or quoted string as value.
      // This is neither, but we wish to parse as much as possible, so reads
      // everything up to the next parameter (or header end).
      assert.deepEqual(r, {a: '(()) b ((""))'});
      assert.equal(parser.value, '');

      parser = new http.HeaderParser(';a=(()) b (("")) \t\r\n ;b=c');
      r = parser.parseParameters(true);
      assert.deepEqual(r, {a: '(()) b ((""))', b: 'c'});
      assert.equal(parser.value, '');

      parser = new http.HeaderParser(';a= \t\r\n "(())" b (("")) \t\r\n ');
      var r = parser.parseParameters(true);
      assert.deepEqual(r, {a: '(())b ((""))'});
      assert.equal(parser.value, '');

      parser = new http.HeaderParser(';a="(())" b (("")) \t\r\n ;b=c');
      var r = parser.parseParameters(true);
      assert.deepEqual(r, {a: '(())b ((""))', b: 'c'});
      assert.equal(parser.value, '');

      parser = new http.HeaderParser(`;param2*1*="utf-8''%e2%82%ac"; param1=value1; param2*0="b"; param2*2="c"; param3=()""(); param4=0`);
      var r = parser.parseParameters(true);
      assert.deepEqual(r, {param1: 'value1', param2: 'b€c', param3: '()""()', param4: '0'});
      assert.equal(parser.value, '');
    });

  });

  describe('#parseMediaType', function() {

    var mediaType = 'main/sub';

    it('should parse media type', function() {
      var parser = new http.HeaderParser(mediaType);
      var r = parser.parseMediaType();
      assert.equal(r, mediaType);
      assert.equal(parser.value, '');
    });

    it('should skip whitespaces around media type', function() {
      var parser = new http.HeaderParser(` \r\n\t ${mediaType} \r\n\t ;`);
      var r = parser.parseMediaType();
      assert.equal(r, mediaType);
      assert.equal(parser.value, ';');
    });

  });

});

describe('ContentType', function() {

  var mainType = 'main';
  var subType = 'sub';
  var mimeType = `${mainType}/${subType}`;

  function guess(ct, filename, expected, ifNeeded) {
    var ct2 = new http.ContentType(expected || ct.mimeType);
    ct.guess(filename, ifNeeded || !expected);
    assert.equal(ct.guessed, !!expected);
    assert.equal(ct.mimeType, ct2.mimeType);
    assert.equal(ct.mainType, ct2.mainType);
    assert.equal(ct.subType, ct2.subType);
  }

  function isKind(mimeType, isText, isImage, isAudio) {
    var ct = new http.ContentType(mimeType);
    assert.equal(ct.isText(), isText);
    assert.equal(ct.maybeText(), isText);
    assert.equal(ct.isImage(), isImage);
    assert.equal(ct.isAudio(), isAudio);
  }

  function isUnknown(mimeType) {
    isKind(mimeType, false, false, false);
  }

  function isText(mimeType) {
    isKind(mimeType, true, false, false);
  }

  function isImage(mimeType) {
    isKind(mimeType, false, true, false);
  }

  function isAudio(mimeType) {
    isKind(mimeType, false, false, true);
  }

  // ContentType relies on HeaderParser.
  // We just need to check it properly handles a full header value.
  it('should parse content type header', function() {
    var ct = new http.ContentType(mimeType);
    assert.equal(ct.mimeType, mimeType);
    assert.equal(ct.mainType, mainType);
    assert.equal(ct.subType, subType);

    ct = new http.ContentType(`${mimeType}; param1=value1 ; param2=value2`);
    assert.equal(ct.mimeType, mimeType);
    assert.equal(ct.mainType, mainType);
    assert.equal(ct.subType, subType);
    assert.deepEqual(ct.params, {param1: 'value1', param2: 'value2'});
  });

  it('should guess mime type from filename', function() {
    var ct = new http.ContentType(mimeType);
    guess(ct, 'test.txt', 'text/plain');
    guess(ct, 'test.htm', 'text/html');
    guess(ct, 'test.html', 'text/html');
    guess(ct, 'test.jpg', 'image/jpeg');
    guess(ct, 'test.mp3', 'audio/mpeg');
  });

  it('should not guess mime type if not needed', function() {
    var ct = new http.ContentType(mimeType);
    guess(ct, 'test.txt', '', true);
  });

  it('should guess mime type if needed', function() {
    var ct = new http.ContentType('application/octet-stream');
    guess(ct, 'test.txt', 'text/plain', true);
  });

  it('should know text types', function() {
    isText('text/whatever');
    isText('whatever/text');
    isText('whatever/html');
    isText('whatever/xml');
  });

  it('may know text types with charset', function() {
    var ct = new http.ContentType(`${mimeType}; charset=whatever`);
    assert.equal(ct.isText(), false);
    assert.equal(ct.maybeText(), true);
    assert.equal(ct.isImage(), false);
    assert.equal(ct.isAudio(), false);
  });

  it('should know image types', function() {
    isImage('image/whatever');
  });

  it('should know audio types', function() {
    isAudio('audio/whatever');
  });

  it('should not known unknown types', function() {
    isUnknown(mimeType);
    isUnknown('whatever/whatever');
    isUnknown('application/octet-stream');
  });

  it('should keep parameters after guessing mime type', function() {
    var ct = new http.ContentType(`${mimeType}; param1=value1; param2=value2`);
    ct.guess('test.txt');
    assert.equal(ct.guessed, true);
    assert.deepEqual(ct.params, {param1: 'value1', param2: 'value2'});

    ct = new http.ContentType(`${mimeType}; param1=value1; param2=value2`);
    ct.guess('test.txt', true);
    assert.equal(ct.guessed, false);
    assert.deepEqual(ct.params, {param1: 'value1', param2: 'value2'});
  });

});
