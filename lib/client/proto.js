var parser = require('./parser');
var writer = require('../server/write');
var Stream = require('net').Stream;
var os = require('os');
var EventEmitter = require('events').EventEmitter;
var undot = require('../dot').undot;
var starttls = require('./starttls');

module.exports = function (hostname, stream, options) {
    if (stream === undefined) {
        stream = hostname;
        hostname = undefined;
    }
    
    var p = parser(stream);
    var write = writer(stream);
    write(220, hostname || os.hostname());
    
    function createAck (cb, okCode, raw) {
        return {
            accept : function (code, msg) {
                write(code, msg || 'OK', okCode || 250);
                if (cb) 
                    if(cb() === false)
                      return;
                if (!raw) next();
            },
            reject : function (code, msg) {
                write(code, msg || 'ERR', 500);
                next();
            }
        };
    }
    
    function emit (name) {
        var fn = arguments[arguments.length - 1];
        var ack = arguments[arguments.length - 1] = createAck(fn);
        if (req.listeners(name).length === 0) ack.accept();
        req.emit.apply(req, arguments);
    }
    
    var req = new EventEmitter;
    req.remoteAddress = stream.remoteAddress;
    
    var next = (function next () {
        p.getCommand(function (err, cmd) {
            if (err) {
                if (err.code) write(err.code, err.message || err.toString())
                else write(501, err.message || err.toString())
                next();
            }
            else if (cmd.name === 'quit') {
                write(221, 'Bye!');
                req.emit('quit');
                stream.end();
            }
            else if (cmd.name === 'rset') {
                write(250, "WTF?!?");
                req.to = undefined;
                req.from = undefined;
                req.emit('rset');
                next();
            }
            else if (cmd.name === 'starttls') {
                emit('starttls', cmd, function() {
                    starttls(stream, options, function (cleartext) {
                        p = parser(cleartext);
                        write = writer(cleartext);
                        req.tls = true;
                        next();
                    });
                    return false;
                });
            }
            else if (cmd.name === 'greeting') {
                emit('greeting', cmd, function () {
                    req.greeting = cmd.greeting;
                    req.hostname = cmd.hostname;
                });
            }
            else if (!req.greeting) {
                write(503, 'Bad sequence: HELO, EHLO, or LHLO expected.');
                next();
            }
            else if (cmd.name === 'auth') {
                if(req.tls) {
                    var getPass = function(cb) {
                        write(334, new Buffer('Password:').toString('base64'));
                        p.getLine(function(line) {
                            //console.log('PASS:' + line);
                            cmd.password = new Buffer(line, 'base64').toString('ascii');
                            cb();
                        });
                    }

                    var getUser = function(cb) {
                        write(334, new Buffer('Username:').toString('base64'));
                        p.getLine(function(line) {
                            //console.log('USER:' + line);
                            cmd.user = new Buffer(line, 'base64').toString('ascii');
                            cb();
                        });
                    }

                    if(!cmd.user) {
                        getUser(function() {
                            getPass(function() { 
                                emit('auth', cmd, function() { 
                                    req.user = cmd.user;
                                });
                            });
                        });
                    }
                    else if(!cmd.password) {
                        getPass(function() {
                            emit('auth', cmd, function() {
                                req.user = cmd.user;
                            });
                        });
                    }
                    else {
                        emit('auth', cmd, function() {
                            req.user = cmd.user;
                        });
                    }
                    
                }
                else {
                    write(503, 'Bad sequence: STARTTLS expected.');
                    next();
                }
            }
            else if (cmd.name === 'mail') {
                emit('from', cmd.from, function () {
                    req.fromExt = cmd.ext;
                    req.from = cmd.from;
                });
            }
            else if (cmd.name === 'rcpt') {
                emit('to', cmd.to, function () {
                    req.toExt = cmd.ext;
                    req.to = cmd.to;
                });
            }
            else if (cmd.name === 'data') {
                if (!req.from) {
                    write(503, 'Bad sequence: MAIL expected');
                    next();
                }
                else if (!req.to) {
                    write(503, 'Bad sequence: RCPT expected');
                    next();
                }
                else {
                    var target = new Stream;
                    target.readable = true;
                    target.writable = true;
                    target.aborted = false;
                    
                    target.write = function (buf) {
                        if (target.readable) target.emit('data', buf)
                    };
                    
                    target.abort = function (code, msg) {
                        if (!msg && typeof code !== 'number') {
                            msg = code;
                            code = undefined;
                        }
                        if (code === undefined) code = 554
                        
                        target.readable = false;
                        target.emit('abort', code, msg);
                    };
                    
                    target.end = function (buf) {
                        target.readable = false;
                        target.emit('end');
                        
                        if (target.aborted) {
                            write(target.aborted.code, target.aborted.message);
                            next();
                        }
                        else emit('received', function () {});
                    };
                    var messageAck = createAck(function () {
                        p.getUntil('.', undot(target));
                    }, 354, true);
                    req.emit('message', target, messageAck);
                }
            }
            else {
                write(502, 'Not implemented.');
                next();
            }
        });
        
        return next;
    })();
    
    return req;
};
