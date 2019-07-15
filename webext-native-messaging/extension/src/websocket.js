'use strict';


class WebSocketClient {

  // Notes:
  // Beware that browsers usually forbid some ports to be used.
  // See: https://stackoverflow.com/questions/4313403/why-do-browsers-block-some-ports
  // e.g. Firefox fails due to 'insecure operation' for ports like 6666.
  //
  // WebSocket can only send messages once it is open ('open' event received).
  // Trying to send a message before (or after it is closed) will fail.
  //
  // If used to send messages without reply before being closed, it is necessary
  // (see documentation) to check 'bufferedAmount' to ensure there is nothing
  // pending to be sent before closing the connection.

  constructor(url) {
    this.url = url;
    this.ws = undefined;
    this.requests = {};
  }

  connect() {
    this.disconnect();
    this.wsConnected = new Deferred();
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener('open', this.onOpen.bind(this));
    this.ws.addEventListener('close', this.onClose.bind(this));
    this.ws.addEventListener('error', this.onError.bind(this));
    this.ws.addEventListener('message', this.onMessage.bind(this));
    return this.wsConnected;
  }

  disconnect() {
    if (this.ws === undefined) return;
    try {
      this.ws.close(1000);
    } catch (error) {
      console.log('Failed to close WebSocket:', error);
    }
    this.ws = undefined;
  }

  postMessage(msg) {
    try {
      msg = JSON.stringify(msg);
    } catch (error) {
      console.error('Failed to stringify WebSocket message %o: %o', msg, error);
      throw error;
    }
    this.ws.send(msg);
  }

  postRequest(msg, timeout) {
    var self = this;
    // Get a unique - non-used - id
    var correlationId;
    do {
      correlationId = uuidv4();
    } while(self.requests[correlationId] !== undefined);
    msg.correlationId = correlationId;

    // Post message
    self.postMessage(msg);

    // Setup response handling
    if (timeout === undefined) timeout = WEBSOCKET_RESPONSE_TIMEOUT;
    var promise = new Deferred().promise;
    self.requests[correlationId] = promise;
    return promiseThen(promiseOrTimeout(promise, timeout), () => {
      // Automatic cleanup of request
      delete(self.requests[correlationId]);
    });
  }

  onOpen(event) {
    this.wsConnected.resolve(event);
  }

  onClose(event) {
    this.wsConnected.reject({close: event});
    // Code 1000 is used when *we* request disconnection.
    if (event.code === 1000) return;
    this.ws = undefined;
    var msg = `WebSocket closed with code=<${event.code}> reason=<${event.reason}> clean=<${event.wasClean}>`;
    console.error(msg);
    for (var promise of Object.values(this.requests)) {
      promise.reject(msg);
    }
    this.requests = {};
  }

  onError(error) {
    this.wsConnected.reject({error: error});
    console.error('WebSocket error:', error);
  }

  onMessage(message) {
    // message.data is the actual content
    try {
      var msg = JSON.parse(message.data);
    } catch (error) {
      console.error('Failed to parse WebSocket message %o: %o', message, error);
      return;
    }
    var correlationId = msg.correlationId;
    var orphan = true;
    if (correlationId !== undefined) {
      var promise = this.requests[correlationId];
      if (promise !== undefined) {
        // Note: request will be automatically removed upon resolving the
        // associated promise.
        delete(msg.correlationId);
        promise.resolve(msg);
        orphan = false;
      }
    }
    if (orphan) {
      console.warn('Received unexpected WebSocket message', msg);
    }
  }

}
