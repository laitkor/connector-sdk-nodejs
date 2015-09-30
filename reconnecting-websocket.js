// MIT License:
//
// Copyright (c) 2010-2012, Joe Walnes
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

/**
 * This behaves like a WebSocket in every way, except if it fails to connect,
 * or it gets disconnected, it will repeatedly poll until it succesfully connects
 * again.
 *
 * It is API compatible, so when you have:
 *   ws = new WebSocket('ws://....');
 * you can replace with:
 *   ws = new ReconnectingWebSocket('ws://....');
 *
 * The event stream will typically look like:
 *  onconnecting
 *  onopen
 *  onmessage
 *  onmessage
 *  onclose // lost connection
 *  onconnecting
 *  onopen  // sometime later...
 *  onmessage
 *  onmessage
 *  etc... 
 *
 * It is API compatible with the standard WebSocket API.
 *
 * Latest version: https://github.com/joewalnes/reconnecting-websocket/
 * - Joe Walnes
 */

var WebSocket = require('ws');
 
function ReconnectingWebSocket(url, protocols) {
    protocols = protocols || [];

    // These can be altered by calling code.
    this.debug = false;
    this.reconnectInterval = 1000;
    this.timeoutInterval = 2000;

    var self = this;
    var ws;
    var forcedClose = false;
    var timedOut = false;
    
    this.url = url;
    this.protocols = protocols;
    this.readyState = WebSocket.CONNECTING;
    this.URL = url; // Public API

    //dummy event functions
    this._onopen = function(){};
    this._onclose = function(){};
    this._onconnecting = function(){};
    this._onmessage = function(){};
    this._onerror = function(){};

    this.onopen = function(cb) {
        this._onopen = cb;
    };

    this.onclose = function(cb) {
        this._onclose = cb;
    };

    this.onconnecting = function(cb) {
        this._onconnecting = cb;
    };

    this.onmessage = function(cb) {
        this._onmessage = cb;
    };

    this.onerror = function(cb) {
        this._onerror = cb;
    };

    function connect(reconnectAttempts) {
        ws = new WebSocket(url, protocols);

        self._onconnecting();
        if (self.debug || ReconnectingWebSocket.debugAll) {
            console.log('ReconnectingWebSocket', 'attempt-connect', reconnectAttempts, url);
        }
        
        var localWs = ws;
        var timeout = setTimeout(function() {
            if (self.debug || ReconnectingWebSocket.debugAll) {
                console.log('ReconnectingWebSocket', 'connection-timeout', url);
            }
            timedOut = true;
            localWs.close();
            timedOut = false;
            setTimeout(function() {
                connect(reconnectAttempts + 1);
            }, self.reconnectInterval);            
        }, self.timeoutInterval);
        
        ws.onopen = function() {
            clearTimeout(timeout);
            if (self.debug || ReconnectingWebSocket.debugAll) {
                console.log('ReconnectingWebSocket', 'onopen', url);
            }
            self.readyState = WebSocket.OPEN;
            reconnectAttempt = 1;
            self._onopen.apply(null, arguments);
        };
        
        ws.onclose = function() {
            clearTimeout(timeout);
            ws = null;
            if (forcedClose) {
                self.readyState = WebSocket.CLOSED;
                self._onclose.apply(null, arguments);
            } else {
                self.readyState = WebSocket.CONNECTING;
                self._onconnecting.apply(null, arguments);
                if (1 === reconnectAttempt && !timedOut) {
                    if (self.debug || ReconnectingWebSocket.debugAll) {
                        console.log('ReconnectingWebSocket', 'onclose', url);
                    }
                    self._onclose.apply(null, arguments);
                }
                setTimeout(function() {
                    connect(reconnectAttempts + 1);
                }, self.reconnectInterval);
            }
        };
        ws.onmessage = function(event) {
            if (self.debug || ReconnectingWebSocket.debugAll) {
                console.log('ReconnectingWebSocket', 'onmessage', url, event.data);
            }
            self._onmessage.call(null, event.data);
        };
        ws.onerror = function() {
            if (self.debug || ReconnectingWebSocket.debugAll) {
                console.log('ReconnectingWebSocket', 'onerror', url, arguments);
            }
            self._onerror.apply(null, arguments);
        };

    }
    connect(1);

    this.send = function(data) {
        if (ws) {
            if (self.debug || ReconnectingWebSocket.debugAll) {
                console.log('ReconnectingWebSocket', 'send', url, data);
            }
            return ws.send(data);
        } else {
            throw 'INVALID_STATE_ERR : Pausing to reconnect websocket';
        }
    };

    this.close = function() {
        if (ws) {
            forcedClose = true;
            ws.close();
        }
    };

    /**
     * Additional public API method to refresh the connection if still open (close, re-open).
     * For example, if the app suspects bad data / missed heart beats, it can try to refresh.
     */
    this.refresh = function() {
        if (ws) {
            ws.close();
        }
    };
}

/**
 * Setting this to true is the equivalent of setting all instances of ReconnectingWebSocket.debug to true.
 */
ReconnectingWebSocket.debugAll = false;

module.exports = ReconnectingWebSocket;