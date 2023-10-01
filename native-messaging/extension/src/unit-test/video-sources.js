'use strict';

import * as assert from 'assert';
import * as util from '../common/util.js';
import { VideoSource, VideoSourceNamer } from '../background/video-sources.js';
import * as vs from '../background/video-sources.js';

describe('VideoSourceNamer', function() {

  function forTitle(s) {
    var videoSource = new VideoSource(undefined, {url: 'http://dummy/'});
    videoSource.setTabTitle(s);
    return new VideoSourceNamer(videoSource);
  }

  function forSite(domain, title) {
    var url = `http://${domain}`;
    var videoSource = new VideoSource(undefined, {url});
    videoSource.setTabTitle(title);
    videoSource.tabSite = util.parseSiteUrl(url);
    return new VideoSourceNamer(videoSource);
  }

  describe('#titleStripStartPart', function() {

    it('should strip given string at start of title', function() {
      // Standard stripping
      var namer = forTitle(' some value - anything else - some value');
      namer.titleStripStartPart('some value');
      assert.equal(namer.title, 'anything else - some value');

      // Strip ignoring spaces inside value
      namer.title = ' somevalue - anything else - somevalue';
      namer.titleStripStartPart('some value');
      assert.equal(namer.title, ' somevalue - anything else - somevalue');
      namer.titleStripStartPart('some value', {withoutSpaces: true});
      assert.equal(namer.title, 'anything else - somevalue');

      // Strip using extra separator.
      namer.title = ' somevalue # anything else # somevalue';
      namer.titleStripStartPart('somevalue');
      assert.equal(namer.title, ' somevalue # anything else # somevalue');
      namer.titleStripStartPart('somevalue', {extraSeparators: '#'});
      assert.equal(namer.title, 'anything else # somevalue');
    });

  });

  describe('#titleStripStartPartRegexp', function() {

    it('should strip given regexp at start of title', function() {
      // Standard stripping
      var namer = forTitle(' some value - anything else - some value');
      namer.titleStripStartPartRegexp(/value/);
      assert.equal(namer.title, 'anything else - some value');

      // Strip ignoring spaces inside value
      namer.title = ' somevalue - anything else - somevalue';
      namer.titleStripStartPartRegexp(/^some value$/);
      assert.equal(namer.title, ' somevalue - anything else - somevalue');
      namer.titleStripStartPartRegexp(/^some *value$/);
      assert.equal(namer.title, 'anything else - somevalue');

      // Strip using extra separator.
      namer.title = ' somevalue # anything else # somevalue';
      namer.titleStripStartPartRegexp('somevalue');
      assert.equal(namer.title, ' somevalue # anything else # somevalue');
      namer.titleStripStartPartRegexp(/somevalue/, {extraSeparators: '#'});
      assert.equal(namer.title, 'anything else # somevalue');
    });

  });

  describe('#titleStripEndPart', function() {

    it('should strip given string at end of title', function() {
      // Standard stripping
      var namer = forTitle(' some value - anything else - some value');
      namer.titleStripEndPart('some value');
      assert.equal(namer.title, 'some value - anything else');

      // Strip ignoring spaces inside value
      namer.title = ' somevalue - anything else - somevalue';
      namer.titleStripEndPart('some value');
      assert.equal(namer.title, ' somevalue - anything else - somevalue');
      namer.titleStripEndPart('some value', {withoutSpaces: true});
      assert.equal(namer.title, 'somevalue - anything else');

      // Strip using extra separator.
      namer.title = ' somevalue # anything else # somevalue';
      namer.titleStripEndPart('somevalue');
      assert.equal(namer.title, ' somevalue # anything else # somevalue');
      namer.titleStripEndPart('somevalue', {extraSeparators: '#'});
      assert.equal(namer.title, 'somevalue # anything else');
    });

  });

  describe('#titleStripEndPartRegexp', function() {

    it('should strip given regexp at end of title', function() {
      // Standard stripping
      var namer = forTitle(' some value - anything else - some value');
      namer.titleStripEndPartRegexp(/value/);
      assert.equal(namer.title, 'some value - anything else');

      // Strip ignoring spaces inside value
      namer.title = ' somevalue - anything else - somevalue';
      namer.titleStripEndPartRegexp(/^some value$/);
      assert.equal(namer.title, ' somevalue - anything else - somevalue');
      namer.titleStripEndPartRegexp(/^some *value$/);
      assert.equal(namer.title, 'somevalue - anything else');

      // Strip using extra separator.
      namer.title = ' somevalue # anything else # somevalue';
      namer.titleStripEndPartRegexp('somevalue');
      assert.equal(namer.title, ' somevalue # anything else # somevalue');
      namer.titleStripEndPartRegexp(/somevalue/, {extraSeparators: '#'});
      assert.equal(namer.title, 'somevalue # anything else');
    });

  });

  describe('#titleStripDomain', function() {

    it('should strip domain at start or end of title', function() {
      var namer = forSite('some.mydomain.tld', ' mydomain - mydomain.tld | some.mydomain.tld # test # some.mydomain.tld | mydomain.tld - mydomain ');
      namer.titleStripDomain({extraSeparators: '#'});
      assert.equal(namer.title, 'mydomain.tld | some.mydomain.tld # test # some.mydomain.tld | mydomain.tld');
      namer.titleStripDomain({extraSeparators: '#'});
      assert.equal(namer.title, 'some.mydomain.tld # test # some.mydomain.tld');
      namer.titleStripDomain({extraSeparators: '#'});
      assert.equal(namer.title, 'test');
    });

  });

  describe('#titleStripRegexp', function() {

    it('should strip regexp matching title', function() {
      var namer = forTitle(' value1 optional1 value2 value3 value4 value5 value6 ');
      namer.titleStripRegexp(/^\s*value1\s*(?:optional1)\s*(?:optional2)?(.*?)value4(.*?)value6\s*$/);
      assert.equal(namer.title, 'value2 value3 value5');
    });

  });

});
