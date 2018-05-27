'use strict';

const constants = require('./constants');
const os = require('os');
const stream = require('stream');
const util = require('util');
const uuidv4 = require('uuid/v4');


// UINT32 size in bytes.
const UINT32_SIZE = 4;

// Split size.
// Max message size is supposed to be 1MB (raw). When splitting into fragments
// we need to take into account extra space for fragment message and fragment
// content escaping (since json as text is embedded in another json).
const MSG_SPLIT_SIZE = 512 * 1024;

const FRAGMENT_KIND_START = 'start';
const FRAGMENT_KIND_CONT = 'cont';
const FRAGMENT_KIND_END = 'end';


// Transforms native message input (bytes) to objects
class NativeSource extends stream.Transform {

  // We receive raw messages (from stdin):
  //  - uint32 (native order): message size
  //  - UTF-8 JSON message

  constructor() {
    // We convert bytes to objects
    super({
      readableObjectMode: true
    });
    // Buffered data to parse
    this.buffer = Buffer.alloc(0);
    this.messageLength = -1;
    this.readUInt32 = Buffer.prototype['readUInt32' + os.endianness()];
  }

  _transform(chunk, encoding, done) {
    // Process RAW data as it arrives.
    // Process is as follow:
    //  - buffer data until we can parse it
    //  - until incoming message size is fully received and parsed, messageLength is negative
    //  - until incoming message is fully received and parsed, messageLength is positive
    this.buffer = Buffer.concat([this.buffer, chunk]);

    // Process received data
    while(true) {
      // Process message size when applicable
      if ((this.messageLength < 0) && (this.buffer.length >= UINT32_SIZE)) {
        // Message size received, decode it
        this.messageLength = this.readUInt32.call(this.buffer, 0);
        this.buffer = this.buffer.slice(UINT32_SIZE);
      }

      // Process message when applicable
      if ((this.messageLength >= 0) && (this.buffer.length >= this.messageLength)) {
        // Message received, decode it
        var message = this.buffer.slice(0, this.messageLength);
        this.buffer = this.buffer.slice(this.messageLength);
        // Reset message size to prepare for next message
        this.messageLength = -1;
        var obj = JSON.parse(message.toString());
        this.push(obj);
        // Loop to process next message is possible
        continue;
      }
      // Not enough received data, wait for more
      break;
    }
    done();
  }

}

// Transform objects into native messages output (bytes)
class NativeSink extends stream.Writable {

  constructor(app) {
    // We receive objects
    super({
      objectMode: true
    });
    this.stdout_write = app.stdout_write;
    this.writeUInt32 = Buffer.prototype['writeUInt32' + os.endianness()];
  }

  _write(msg, encoding, done) {
    this.writeMessage(msg);
    done();
  }

  writeMessage(msg, noSplit) {
    var json = JSON.stringify(msg);

    if (!noSplit && (json.length > MSG_SPLIT_SIZE)) {
      try {
        this.writeFragments(msg, json);
      } catch (error) {
        console.error(error);
      }
      return;
    }

    var len = Buffer.alloc(4);
    var buf = Buffer.from(json);

    this.writeUInt32.call(len, buf.length, 0);

    this.stdout_write(len);
    this.stdout_write(buf);
  }

  writeFragments(msg, json) {
    var length = json.length;
    var fragment = {
      feature: msg.feature,
      kind: msg.kind,
      correlationId: uuidv4()
    };

    for (var offset = 0; offset < length; offset += MSG_SPLIT_SIZE) {
      fragment.content = json.slice(offset, offset + MSG_SPLIT_SIZE);
      fragment.fragment = (offset == 0
        ? constants.FRAGMENT_KIND_START
        : (offset + MSG_SPLIT_SIZE >= length
            ? constants.FRAGMENT_KIND_END
            : constants.FRAGMENT_KIND_CONT
          )
      );
      this.writeMessage(fragment, true);
    }
  }

}

// Handles application messages
class NativeHandler extends stream.Writable {

  constructor(handler, app) {
    // We receive objects
    super({
      objectMode: true
    });
    this.handler = handler;
    this.app = app;
  }

  _write(msg, encoding, done) {
    var r = this.handler(this.app, msg);
    if (r instanceof Promise) {
      var response = {
        feature: msg.feature,
        kind: msg.kind,
        correlationId: msg.correlationId
      };
      r.then(v => {
        if (typeof(v) !== 'object') return;
        this.app.postMessage(Object.assign(response, v));
      }).catch(error => {
        this.app.postMessage(Object.assign(response, {error: error}));
      })
    }
    done();
  }

}

// Native application (plumbing)
class NativeApplication {

  // Notes:
  // We could react on process 'uncaughtException' to generate a proper message
  // before exiting. But the default behaviour (log on stderr) is enough.
  // See: https://nodejs.org/api/process.html#process_event_uncaughtexception

  constructor(handler) {
    // Wrap stdout/stderr to transform it into (log) native messages
    this.stdout_write = process.stdout.write.bind(process.stdout);
    this.wrapOutput(process.stdout, 'info');
    this.wrapOutput(process.stderr, 'error');

    // Wrap console logging to transform is into (log) native messages
    for (var level of ['log', 'debug', 'info', 'warn', 'error']) {
      this.wrapConsole(level);
    }

    // Native messaging:
    // Create a sink to transform objects into messages.
    // (also wraps stdout/stderr to transform it into (log) native messages)
    // Process stdin to decode incoming native messages and process them.
    // (output messages are written to sink when needed)

    //process.stdin.resume();
    // Once EOS is reached, it is time to stop.
    process.stdin.on('end', () => this.terminate());

    this.sink = new NativeSink(this);
    process.stdin
      .pipe(new NativeSource())
      .pipe(new NativeHandler(handler, this));
  }

  terminate(code) {
    process.exit(code);
  }

  postMessage(msg) {
    this.sink.write(msg);
  }

  wrapOutput(output, level) {
    var self = this;
    output.write = function (chunk, encoding, done) {
      self.postMessage({
        feature: constants.FEATURE_APP,
        kind: constants.KIND_CONSOLE,
        level: level,
        content: chunk.replace(/\r?\n+$/, '')
      });
      done();
    }
  }

  wrapConsole(level) {
    var self = this;
    console[level] = function (...args) {
      self.postMessage({
        feature: constants.FEATURE_APP,
        kind: constants.KIND_CONSOLE,
        level: level,
        args: args
      });
    }
  }

}


exports.NativeApplication = NativeApplication;
