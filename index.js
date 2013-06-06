var net = require('net');
var tls = require('tls');

var proto = exports.protocol = {
    client : require('./lib/client/proto'),
    server : require('./lib/server/proto'),
};

exports.createServer = function (domain, cb, options) {
    if (typeof domain === 'function') {
        cb = domain;
        domain = undefined;
    }
    
    return net.createServer(function (stream) {
        cb(proto.client(domain, stream, options));
    });
};

exports.connect = function () {
    var args = [].slice.call(arguments).reduce(function (acc, arg) {
        acc[typeof arg] = arg;
        return acc;
    }, {});

    var stream;
    var cb = args.function;
    var options = args.object || {};
    
    var port = args.number || 25;
    var host = args.string || 'localhost';
    var tlsOpts = options.tls;
    
    if (args.string && args.string.match(/^[.\/]/)) {
        // unix socket
        stream = net.createConnection(args.string);
    }
    else if (tlsOpts) {
        stream = tls.connect(port, host, tlsOpts, function () {
            var pending = stream.listeners('secure').length;
            var allOk = true;
            if(pending === 0){
                if(!stream.authorized && tlsOpts.rejectUnauthorized !== false) allOk = false;
            }
            if (pending === 0) done()
            else {
                var ack = {
                    accept : function (ok) {
                        allOk = allOk && (ok !== false);
                        if (--pending === 0) done();
                    },
                    reject : function () {
                        allOk = false;
                        if (--pending === 0) done();
                    }
                };
                stream.emit('secure', ack);
            }
            
            function done () {
                if (!allOk) {
                    stream.end();
                    stream.emit('error', new Error(stream.authorizationError));
                }
                else cb(proto.server(stream));
            }
        });
    }
    else if (options.stream) {
        cb(proto.server(options.stream));
    }
    else {
        stream = net.createConnection(port, host);
        stream.on('connect', function () {
            cb(proto.server(stream));
        });
    }
    
    return stream;
};

var logger = {
    debug: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error
  };

exports.connectMx = function(domain, callback) {
    require('dns').resolveMx(domain, function(err, data) {
        if (err)
          return callback(err);

        data.sort(function(a, b) {return a.priority < b. priority});
        logger.debug('mx resolved: ', data);

        if (!data || data.length == 0)
          return callback(new Error('can not resolve Mx of <' + domain + '>'));

        function tryConnect(i) {

          if (i >= data.length) return callback(new Error('can not connect to any SMTP server'));

          var sock = net.createConnection(25, data[i].exchange);

          sock.on('error', function(err) {
              logger.error('Error on connectMx for: ', data[i], err);
              tryConnect(++i);
          });

          sock.on('connect', function() {
              logger.debug("MX connection created: ", data[i].exchange);
              sock.removeAllListeners('error');
              callback(null, sock);
          });

        };

        tryConnect(0);
    });
  }
