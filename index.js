var util = require('util');
var WebSocket = require('./reconnecting-websocket.js');
var express = require('express');
var _ = require('underscore');
var uuid = require('node-uuid');

//Some default options
var defaultOptions = {
	websocketUrl: process.env.CONNECTOR_WEBSOCKET_URL,
	httpPort: process.env.CONNECTOR_HTTP_PORT
}


module.exports = function (options) {

	//extend the default options
	options = _.extend(defaultOptions, options);

	if (!options.websocketUrl) {
		throw new Error("Invalid websocket url passed to tray.io node.js connector");
	}

	console.info("Initialising tray.io node.js connector");

	//setup initial properties

	//is the connector ready yet?
	this._ready = false;	

	//Queue for storing messages to be sent
	//while the websocket is not ready
	this._messageQueue = [];

	//store the message handlers
	this._messageHandlers = {};

	//store handlers for correlation ids
	this._correlationHandlers = {};

	//handler method for health calls
	this._healthHandler = null;

	//handler method for http trigger requests
	this._httpTriggerHandler = null;

	//the http server reference
	this.httpApp = null;

	//setup initial methods

	//setup a connector message handler
	this.on = function(message, handler) {
		console.log("Adding message handler for %s", message);
		this._messageHandlers[message] = handler;
	};

	//setup a health check handler
	this.onHealthCheck = function(handler) {
		this._healthHandler = handler;
	};

	//setup a connector http trigger handler
	this.trigger = function(httpTriggerHandler, middlewareCallback) {
		this._httpTriggerHandler = httpTriggerHandler;

		console.log("Creating a trigger HTTP server on port %s", options.httpPort);

		this.httpApp = express();
		this.httpApp.listen(options.httpPort);

		//call middleware callback before we 
		if (middlewareCallback) {
			middlewareCallback();
		}

		//listen to all requests
		this.httpApp.all('*', function(httpRequest, httpResponse, next) {
			console.log("Received incoming http request on %s", httpRequest.url);

			//Check if the request is a healthz request			
			if ("/healthz" === httpRequest.url) {
				if (this._healthHandler) {
					this._healthHandler(function(response) {
						httpResponse.writeHead("healthy" === response ? 200 : 500);
						httpResponse.end();
					}.bind(this));
				} else {
					httpResponse.writeHead(500);
					httpResponse.end();
				}
				return;
			}

			//Get the workflow details
			var workflowRef = httpRequest.headers['x-connector-workflow'],
				connectorName = httpRequest.headers['x-connector-name'],
				connectorVersion = httpRequest.headers['x-connector-version'],
				connectorMessage = httpRequest.headers['x-connector-message'];

			console.log("Connector metadata - workflow: %s name: %s version: %s message: %s", workflowRef, connectorName, connectorVersion, connectorMessage);

			//get the meta data for the workflow ref
			this.getMetadata(workflowRef, function(metaData) {

				//call the http trigger handler with the request/response, reference, meta data etc
				this._httpTriggerHandler(httpRequest, httpResponse, metaData, {
					workflow: workflowRef,
					connector: connectorName,
					version: connectorVersion,
					message: connectorMessage
				}, function(output, responseCallback) {
					this.triggerWorkflow(workflowRef, output, function(body) {
						if (responseCallback)
							responseCallback(body);
						//finish the middleware
						next();
					});
				}.bind(this));
				
			}.bind(this));				



		}.bind(this));		
		
	};

	//allow for middleware to be added to express
	this.use = function() {
		if (!this.httpApp)
			throw new Error("Cannot add express middleware as there is not a valid connection");
		console.log("Adding express middleware");
		var args = Array.prototype.slice.call(arguments);		
		this.httpApp.use.apply(this.httpApp, args);
	}

	//trigger a workflow with some output data
	this.triggerWorkflow = function(workflowRef, output, callback) {
		console.log("Triggering workflow %s with output %s", workflowRef, JSON.stringify(output));

		//Generate a correlation id
		var correlationId = uuid.v4();

		//if there is a callback function
		if (callback) {

			//add a correlation id handler function
			this._correlationHandlers[correlationId] = function(messageData) {
				console.log("Got trigger response for %s with correlation id %s", workflowRef, correlationId);
				//call the callback with the meta data message body
				callback(messageData.body);
				//remove the correlation id
				delete this._correlationHandlers[correlationId];
			}.bind(this);

			console.log("Sending trigger request/response for %s with correlation id %s", workflowRef, correlationId);

		} else {
			console.log("Sending trigger fire & forget for %s with correlation id %s", workflowRef, correlationId);
		}

		//send the meta data request
		this._wsMessage(correlationId, {
			message: "trigger_request",
			workflow_ref: workflowRef
		}, output);		
	};

	//get workflow meta data
	this.getMetadata = function(workflowRef, callback) {

		console.log("Metadata request for %s", workflowRef);

		//Generate a correlation id
		var correlationId = uuid.v4();

		//add a correlation id handler function
		this._correlationHandlers[correlationId] = function(messageData) {
			console.log("Got metadata response for %s with correlation id %s", workflowRef, correlationId);
			//call the callback with the meta data message body
			callback(messageData.body);
			//remove the correlation id
			delete this._correlationHandlers[correlationId];
		}.bind(this);

		console.log("Sending metadata request for %s with correlation id %s", workflowRef, correlationId);

		//send the meta data request
		this._wsMessage(correlationId, {
			message: "trigger_meta_request",
			workflow_ref: workflowRef
		});
	};

	//log and send an error message back to the web socket
	this._wsError = function(id, code, error, payload) {
		console.error(new Error(error));
		//send the message
		this._wsMessage(id, {
		    error: true
		}, {
		    code: code,
		    message: error,
		    payload: payload || {}
		});
	};

	//send a message back to the websocket
	this._wsMessage = function(id, header, body) {
		if (!this._ready) {
			console.log('Websocket not ready, queueing message');
			//add a callback to the message queue to do the message again
			this._messageQueue.push(function() {
				this._wsMessage(id, header, body);
			}.bind(this));
		} else {
			console.log('Sending connector message');
			this.ws.send(JSON.stringify({
			  id: id,
			  header: header || {},
			  body: body || {}
			}));
		}
	}

	console.log("Connecting to connector websocket on %s", options.websocketUrl);
	this.ws = new WebSocket(options.websocketUrl);

	//handle websocket connecting
	this.ws.onopen(function() {
	  	console.log("Websocket connected");
	  	this._ready = true;

	  	if (!_.isEmpty(this._messageQueue)) {
	  		console.log("Replaying %d queued websocket messages", this._messageQueue.length);
		  	//make sure any queued messages are sent
		  	while (!_.isEmpty(this._messageQueue)) {
		  		var cb = this._messageQueue.shift();
		  		cb();
		  	}
		}

	}.bind(this));

	//handle websocket disconnects
	this.ws.onclose(function() {
	  console.log('Websocket disconnected');
	  this._ready = false;
	}.bind(this));

	//handle websocket message
	this.ws.onmessage(function(messageData, messageFlags) {
		//get the actual messageData json
		if (_.isString(messageData))
			messageData = JSON.parse(messageData);
		var correlationId = messageData.id;

		console.log("Incoming websocket message %s", JSON.stringify(messageData));

		//If there is no message
		if (!messageData.header || !messageData.header.message) {
			//Check the correlation id
			var handler = this._correlationHandlers[correlationId];
			if (handler) {
				handler(messageData);
				return;
			}
			this._wsError(correlationId, "invalid_payload", "Invalid websocket message received (header.message required)");
			return;
		}		

		if ("healthz" == messageData.header.message) {
			if (this._healthHandler) {
				this._healthHandler(function(response) {
					this._wsMessage(correlationId, {}, {
						state: response
					});
				}.bind(this));
			} else {
				this._wsMessage(correlationId, {}, {
					state: "unhealthy"
				});
			}
			return;
		}

		var handler = this._messageHandlers[messageData.header.message];
		if (!handler) {
			this._wsError(correlationId, "not_implemented", util.format("Could not find a valid message handler for %s", messageData.header.message));
			return;
		}
		try {
			//call the handler, passing the body and a callback to reply
			handler(messageData.body, function(response) {
				//send the reply back with the same correlation id
				this._wsMessage(correlationId, {}, response);
			}.bind(this), function(code, message, payload) {
				this._wsError(correlationId, code, message, payload);
			}.bind(this));
		} catch (e) {
			this._wsError(correlationId, "exception", e.message);
		}
	}.bind(this));	




}
