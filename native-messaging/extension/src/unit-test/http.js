'use strict';

import * as assert from 'assert';
import * as http from '../common/http.js';


describe('http', function() {

  describe('findHeader/findHeaderValue', function() {

    function test(headers, name, expected) {
      // Test findHeader
      let r = http.findHeader(headers, name);
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

    it('should handle undefined headers', function() {
      test(undefined, 'Header', undefined);
      test(null, 'Header', undefined);
    });

  });

});

describe('HeaderParser', function() {

  describe('#skipFWS', function() {

    it('should skip any whitespace', function() {
      [' ', '\t', '\r', '\n'].forEach(c => {
        let parser = new http.HeaderParser(`${c}a`);
        assert.equal(parser.skipFWS(), (c != '\n') ? c : ' ');
        assert.equal(parser.value, 'a');
      })
    });

    it('should skip multiple whitespaces', function() {
      let parser = new http.HeaderParser(` \r \t a`);
      assert.equal(parser.skipFWS(), ' \r \t ');
      assert.equal(parser.value, 'a');
      parser = new http.HeaderParser(` \r\n \t a`);
      assert.equal(parser.skipFWS(), ' ');
      assert.equal(parser.value, 'a');
    });

  });

  describe('#parseToken', function() {

    it('should match all token characters', function() {
      let token = "!#$%&'*+-.^_\`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
      '" \r\n\t(),/:;<=>?@[\\]{}]'.split('').forEach(c => {
        let parser = new http.HeaderParser(`${token}${c}`);
        let r = parser.parseToken();
        assert.equal(r, token);
        assert.equal(parser.value, /\s/.test(c) ? '' : c);
      });
    });

    it('should skip whitespaces around token', function() {
      let parser = new http.HeaderParser(' \t a\r\nb');
      let r = parser.parseToken();
      assert.equal(r, 'a');
      assert.equal(parser.value, 'b');
    });

  });

  describe('#skipComment', function() {

    it('should skip comment', function() {
      let parser = new http.HeaderParser('(anything "whatever" \(\))b');
      parser.skipComment();
      assert.equal(parser.value, 'b');
    });

    it('should handle recursive comment', function() {
      let parser = new http.HeaderParser('(anything ("whatever") \(\))b');
      parser.skipComment();
      assert.equal(parser.value, 'b');
    });

    it('should also skip whitespaces around comment', function() {
      let parser = new http.HeaderParser(' \t ()\r\nb');
      parser.skipComment();
      assert.equal(parser.value, 'b');
    });

  });

  describe('#decodeString', function() {

    let parser = new http.HeaderParser('');

    it('should handle plain value', function() {
      let r = parser.decodeString("utf-8'language'value");
      assert.equal(r, 'value');
    });

    it('should handle UTF-8 value', function() {
      let r = parser.decodeString("utf-8'anything'%c2%a3%20and%20%e2%82%ac%20rates");
      assert.equal(r, '£ and € rates');
    });

    it('should ignore language', function() {
      let r = parser.decodeString("utf-8''value");
      assert.equal(r, 'value');
    });

    it('should simply unescape for unknown charset', function() {
      let r = parser.decodeString("anything''%E4%F6%FC");
      assert.equal(r, 'äöü');
    });

    it('should not change non-encoded string', function() {
      let r = parser.decodeString("utf-8");
      assert.equal(r, "utf-8");
      r = parser.decodeString("utf-8'%E4%F6%FC");
      assert.equal(r, "utf-8'%E4%F6%FC");
    });

  });

  describe('#parseParameters', function() {

    it('should handle a token parameter value', function() {
      let parser = new http.HeaderParser(';a=b');
      let r = parser.parseParameters(true);
      assert.deepEqual(r, {a: 'b'});
      assert.equal(parser.value, '');
    });

    it('should handle a quoted string parameter value', function() {
      let parser = new http.HeaderParser(';a="b\\"c');
      let r = parser.parseParameters(true);
      assert.deepEqual(r, {a: 'b"c'});
      assert.equal(parser.value, '');
    });

    it('should handle an encoded parameter value', function() {
      let parser = new http.HeaderParser(`;a*="utf-8''%e2%82%ac"`);
      let r = parser.parseParameters(true);
      assert.deepEqual(r, {a: '€'});
      assert.equal(parser.value, '');
    });

    it('should handle a split parameter value', function() {
      let parser = new http.HeaderParser(`;a*0="b";a*2="c";a*1*="utf-8''%e2%82%ac"`);
      let r = parser.parseParameters(true);
      assert.deepEqual(r, {a: 'b€c'});
      assert.equal(parser.value, '');
    });

    it('should skip whitespaces', function() {
      let parser = new http.HeaderParser(' \t\r\n ; \t\r\n a \t\r\n = \t\r\n b \t\r\n ');
      let r = parser.parseParameters(true);
      assert.deepEqual(r, {a: 'b'});
      assert.equal(parser.value, '');
    });

    it('should skip comments if requested', function() {
      let parser = new http.HeaderParser(' \t\r\n ; \t\r\n a \t\r\n = \t\r\n (( \t\r\n )) \t\r\n b \t\r\n (( ""\t\r\n )) \t\r\n ');
      let r = parser.parseParameters();
      assert.deepEqual(r, {a: 'b'});
      assert.equal(parser.value, '');
    });

    it('should handle multiple parameters', function() {
      let parser = new http.HeaderParser(`;param2*1*="utf-8''%e2%82%ac"; param1=value1; param2*0="b"; param2*2="c"; param3=()""(); param4=0`);
      let r = parser.parseParameters();
      assert.deepEqual(r, {param1: 'value1', param2: 'b€c', param3: '', param4: '0'});
      assert.equal(parser.value, '');
    });

    it('should handle malformed values', function() {
      let parser = new http.HeaderParser('; \t\r\n a \t\r\n = \t\r\n (()) b (("")) \t\r\n ');
      let r = parser.parseParameters(true);
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
      r = parser.parseParameters(true);
      assert.deepEqual(r, {a: '(())b ((""))'});
      assert.equal(parser.value, '');

      parser = new http.HeaderParser(';a="(())" b (("")) \t\r\n ;b=c');
      r = parser.parseParameters(true);
      assert.deepEqual(r, {a: '(())b ((""))', b: 'c'});
      assert.equal(parser.value, '');

      parser = new http.HeaderParser(`;param2*1*="utf-8''%e2%82%ac"; param1=value1; param2*0="b"; param2*2="c"; param3=()""(); param4=0`);
      r = parser.parseParameters(true);
      assert.deepEqual(r, {param1: 'value1', param2: 'b€c', param3: '()""()', param4: '0'});
      assert.equal(parser.value, '');
    });

  });

  describe('#parseMediaType', function() {

    let mediaType = 'main/sub';

    it('should parse media type', function() {
      let parser = new http.HeaderParser(mediaType);
      let r = parser.parseMediaType();
      assert.equal(r, mediaType);
      assert.equal(parser.value, '');
    });

    it('should lower-case value', function() {
      let parser = new http.HeaderParser(mediaType.toUpperCase());
      let r = parser.parseMediaType();
      assert.equal(r, mediaType);
      assert.equal(parser.value, '');
    });

    it('should skip whitespaces around media type', function() {
      let parser = new http.HeaderParser(` \r\n\t ${mediaType} \r\n\t ;`);
      let r = parser.parseMediaType();
      assert.equal(r, mediaType);
      assert.equal(parser.value, ';');
    });

  });

});

describe('ContentType', function() {

  let mainType = 'main';
  let subType = 'sub';
  let mimeType = `${mainType}/${subType}`;

  function guess(ct, filename, expected, ifNeeded) {
    let ct2 = new http.ContentType(expected || ct.mimeType);
    ct.guess(filename, ifNeeded || !expected);
    assert.equal(ct.guessed, !!expected);
    assert.equal(ct.mimeType, ct2.mimeType);
    assert.equal(ct.mainType, ct2.mainType);
    assert.equal(ct.subType, ct2.subType);
  }

  function isKind(mimeType, isText, isImage, isAudio, isHLS, isSubtitle) {
    let ct = new http.ContentType(mimeType);
    assert.equal(ct.isText(), isText);
    assert.equal(ct.maybeText(), isText);
    assert.equal(ct.isImage(), isImage);
    assert.equal(ct.isAudio(), isAudio);
    assert.equal(ct.isHLS(), isHLS);
    assert.equal(ct.isSubtitle(), isSubtitle);
  }

  function isUnknown(mimeType) {
    isKind(mimeType, false, false, false, false, false);
  }

  function isText(mimeType) {
    isKind(mimeType, true, false, false, false, false);
  }

  function isImage(mimeType) {
    isKind(mimeType, false, true, false, false, false);
  }

  function isAudio(mimeType) {
    isKind(mimeType, false, false, true, false, false);
  }

  function isHLS(mimeType) {
    isKind(mimeType, false, false, false, true, false);
  }

  function isSubtitle(mimeType) {
    isKind(mimeType, false, false, false, false, true);
  }

  function mimeExtension(mimeType, expected) {
    let ct = new http.ContentType(mimeType);
    assert.strictEqual(ct.getMimeExtension(), expected);
  }

  // ContentType relies on HeaderParser.
  // We just need to check it properly handles a full header value.
  it('should parse content type header', function() {
    let ct = new http.ContentType(mimeType);
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
    let ct = new http.ContentType(mimeType);
    guess(ct, 'test.txt', 'text/plain');
    guess(ct, 'test.htm', 'text/html');
    guess(ct, 'test.html', 'text/html');
    guess(ct, 'test.jpg', 'image/jpeg');
    guess(ct, 'test.mp3', 'audio/mpeg');
    guess(ct, 'test.mpa', 'audio/mpeg');
    guess(ct, 'test.m3u8', 'application/vnd.apple.mpegurl');
    guess(ct, 'test.srt', 'application/x-subrip');
    guess(ct, 'test.vtt', 'text/vtt');
  });

  it('should not guess mime type if not needed', function() {
    let ct = new http.ContentType(mimeType);
    guess(ct, 'test.txt', '', true);
  });

  it('should guess mime type if needed', function() {
    let ct = new http.ContentType('application/octet-stream');
    guess(ct, 'test.txt', 'text/plain', true);
  });

  it('should know text types', function() {
    isText('text/whatever');
    isText('whatever/text');
    isText('whatever/html');
    isText('whatever/xml');
  });

  it('may know text types with charset', function() {
    let ct = new http.ContentType(`${mimeType}; charset=whatever`);
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

  it('should know HLS types', function() {
    isHLS('application/vnd.apple.mpegurl');
    isHLS('application/mpegurl');
    isHLS('application/x-mpegurl');
    isHLS('application/vnd.apple.mpegurl.audio');
    isHLS('audio/mpegurl');
    isHLS('audio/x-mpegurl');

    let ct = new http.ContentType('video/mp2t');
    assert.equal(ct.isHLS(), false);
    assert.equal(ct.maybeHLS(), false);
    assert.equal(ct.maybeHLS('file.ext'), false);
    assert.equal(ct.maybeHLS('file.m3u8'), true);
  });

  it('should know subtitle types', function() {
    isSubtitle('application/x-subrip');
    isSubtitle('text/vtt');
  });

  it('should not known unknown types', function() {
    isUnknown(mimeType);
    isUnknown('whatever/whatever');
    isUnknown('application/octet-stream');
  });

  it('should keep parameters after guessing mime type', function() {
    let ct = new http.ContentType(`${mimeType}; param1=value1; param2=value2`);
    ct.guess('test.txt');
    assert.equal(ct.guessed, true);
    assert.deepEqual(ct.params, {param1: 'value1', param2: 'value2'});

    ct = new http.ContentType(`${mimeType}; param1=value1; param2=value2`);
    ct.guess('test.txt', true);
    assert.equal(ct.guessed, false);
    assert.deepEqual(ct.params, {param1: 'value1', param2: 'value2'});
  });

  it('should get main extension for given mime type', function() {
    mimeExtension(mimeType, undefined);
    mimeExtension('text/plain', 'txt');
    mimeExtension('text/html', 'html');
    mimeExtension('audio/mpeg', undefined);
  });

});

describe('ContentDisposition', function() {

  // ContentDisposition relies on HeaderParser.
  // We just need to check it properly handles a full header value.
  it('should parse content disposition header', function() {
    let cd = new http.ContentDisposition('inline');
    assert.equal(cd.kind, 'inline');
    assert.deepEqual(cd.params, {});

    cd = new http.ContentDisposition('attachment');
    assert.equal(cd.kind, 'attachment');
    assert.deepEqual(cd.params, {});

    cd = new http.ContentDisposition('attachment; param1=value1 ; param2=value2');
    assert.equal(cd.kind, 'attachment');
    assert.deepEqual(cd.params, {param1: 'value1', param2: 'value2'});

    cd = new http.ContentDisposition('param1=value1 ; param2=value2');
    assert.equal(cd.kind, '');
    assert.deepEqual(cd.params, {param1: 'value1', param2: 'value2'});
  });

});

describe('Cookie', function() {

  it('should handle unexisting value', function() {
    assert.equal((new http.Cookie()).value(), undefined);
    assert.equal((new http.Cookie(null)).value(), undefined);
  });

  it('should handle nominal cookies', function() {
    let cookie = 'a=b; A=c; a=d; a=';
    let c = new http.Cookie(cookie);
    assert.equal(c.value(), cookie);
    assert.equal(c.find('a'), 'b');
    assert.equal(c.find('A'), 'c');
    assert.deepEqual(c.findAll('a'), ['b', 'd', '']);
  });

  it('should handle spaceless cookies', function() {
    let cookie = 'a=b;A=c;a=d;a=';
    let c = new http.Cookie(cookie);
    assert.equal(c.find('a'), 'b');
    assert.equal(c.find('A'), 'c');
    assert.deepEqual(c.findAll('a'), ['b', 'd', '']);
  });

  it('should handle removing cookies', function() {
    let c = new http.Cookie('a=1; a=2; a=3; A=1; A=2; a=; b=1');
    assert.equal(c.remove('a', true).value(), 'a=2; a=3; A=1; A=2; a=; b=1');
    assert.equal(c.remove('A').value(), 'a=2; a=3; a=; b=1');
  });

  it('should handle adding cookies', function() {
    let c = new http.Cookie('a=1; a=2; a=3; A=1; A=2; a=4; b=1');
    assert.equal(c.add('a', '1').value(), 'a=1; a=2; a=3; A=1; A=2; a=4; b=1; a=1');
  });

  it('should handle setting cookies', function() {
    let c = new http.Cookie('a=1; a=2; a=3; A=1; A=2; a=4; b=1');
    assert.equal(c.set('a', '4', true).value(), 'a=4; a=2; a=3; A=1; A=2; a=4; b=1');
    assert.equal(c.set('a', '5').value(), 'a=5; A=1; A=2; b=1');
    assert.equal(c.set('B', '1').value(), 'a=5; A=1; A=2; b=1; B=1');
  });

  it('should handle quoted values', function() {
    let c = new http.Cookie(' a = 1 ; a = "2" ; a = " 3 " ; a = "" ');
    assert.deepEqual(c.findAll('a'), ['1', '2', ' 3 ', '']);
    assert.equal(c.set('a', ' 1', true).value(), 'a=" 1"; a=2; a=" 3 "; a=');
    assert.equal(c.set('a', '1 ', true).value(), 'a="1 "; a=2; a=" 3 "; a=');
    assert.equal(c.set('a', '1', true).value(), 'a=1; a=2; a=" 3 "; a=');
    assert.equal(c.set('b', '1 ').value(), 'a=1; a=2; a=" 3 "; a=; b="1 "');
  });

  it('should handle nameless cookies', function() {
    let c = new http.Cookie('=1; 2; ; ""; b=1;');
    assert.equal(c.find(''), '=1');
    assert.deepEqual(c.findAll(''), ['=1', '2', '', '', '']);
    assert.equal(c.add('a', '1').value(), '=1; 2; ; ; b=1; ; a=1');
    assert.equal(c.set('', '1', true).value(), '1; 2; ; ; b=1; ; a=1');
    assert.equal(c.set('', '=1', true).value(), '=1; 2; ; ; b=1; ; a=1');
    assert.equal(c.remove('', true).value(), '2; ; ; b=1; ; a=1');
    assert.equal(c.set('', ' 2', true).value(), '" 2"; ; ; b=1; ; a=1');
  });

});
