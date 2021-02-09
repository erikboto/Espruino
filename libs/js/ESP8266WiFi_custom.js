/* 
  Copyright (c) 2015 Gordon Williams, Pur3 Ltd. See the file LICENSE for copying permission. 
  Copyright (c) 2021 Autoliv
*/
/*
Custom library for interfacing to the EspressIF ESP8266, to enable file transfers using
WiFi-Passthrough mode.

Based on ESP8266WiFi_0v25
*/

var at;
var ENCR_FLAGS = ["open","wep","wpa_psk","wpa2_psk","wpa_wpa2_psk"];
var my_usart;

var wifiFuncs = {
  // initialise the ESP8266
  "init" : function(callback) {
    at.cmd("ATE0\r\n",1000,function cb(d) { // turn off echo
      if (d=="ATE0") return cb;
      if (d=="OK") {
        at.cmd("AT+CIPMUX=0\r\n",1000,function(d) { // turn on multiple sockets
          if (d!="OK") callback("CIPMUX failed: "+(d?d:"Timeout"));
          else at.cmd("AT+CIPDINFO=1\r\n",1000, function() { // Turn on UDP transmitter info
            callback(null); // we don't care if this succeeds or not
          });
        });
      }
      else callback("ATE0 failed: "+(d?d:"Timeout"));
    });
  },
  "reset" : function(callback) {
    at.cmd("\r\nAT+RST\r\n", 10000, function cb(d) {
      //console.log(">>>>>"+JSON.stringify(d));
      // 'ready' for 0.25, 'Ready.' for 0.50
      if (d=="ready" || d=="Ready.") setTimeout(function() { wifiFuncs.init(callback); }, 1000);
      else if (d===undefined) callback("No 'ready' after AT+RST");
      else return cb;
    });
  },
  "getVersion" : function(callback) {
    at.cmd("AT+GMR\r\n", 1000, function(d) {
      // works ok, but we could get more data
      callback(null,d);
    });
  },
  "connect" : function(ssid, key, callback) {
    at.cmd("AT+CWMODE=1\r\n", 1000, function(cwm) {
      if (cwm!="no change" && cwm!="OK") callback("CWMODE failed: "+(cwm?cwm:"Timeout"));
      else at.cmd("AT+CWJAP="+JSON.stringify(ssid)+","+JSON.stringify(key)+"\r\n", 20000, function cb(d) {
        if (["WIFI DISCONNECT","WIFI CONNECTED","WIFI GOT IP","+CWJAP:1"].indexOf(d)>=0) return cb;
        if (d!="OK") setTimeout(callback,0,"WiFi connect failed: "+(d?d:"Timeout"));
        else setTimeout(callback,0,null);
      });
    });
  },
  "getAPs" : function (callback) {
    var aps = [];
    at.cmdReg("AT+CWLAP\r\n", 5000, "+CWLAP:",
              function(d) {
                var ap = d.slice(8,-1).split(",");
                aps.push({ ssid : JSON.parse(ap[1]),
                           enc: ENCR_FLAGS[ap[0]],
                           signal: parseInt(ap[2]),
                           mac : JSON.parse(ap[3]) });
              },
              function() { callback(null, aps); });
  },
  "getConnectedAP" : function(callback) {
    var con;
    at.cmdReg("AT+CWJAP?\r\n", 1000, "+CWJAP:",
              function(d) { con=JSON.parse(d.slice(7)); },
              function() { callback(null, con); });
  },
  "createAP" : function(ssid, key, channel, enc, callback) {
    at.cmd("AT+CWMODE=2\r\n", 1000, function(cwm) {
      if (cwm!="no change" && cwm!="OK" && cwm!="WIFI DISCONNECT") callback("CWMODE failed: "+(cwm?cwm:"Timeout"));
      var encn = enc ? ENCR_FLAGS.indexOf(enc) : 0;
      if (encn<0) callback("Encryption type "+enc+" not known - "+ENCR_FLAGS);
      else at.cmd("AT+CWSAP="+JSON.stringify(ssid)+","+JSON.stringify(key)+","+channel+","+encn+"\r\n", 5000, function(cwm) {
        if (cwm!="OK") callback("CWSAP failed: "+(cwm?cwm:"Timeout"));
        else callback(null);
      });
    });
  },
  "getConnectedDevices" : function(callback) {
    var devs = [];
    this.at.cmd("AT+CWLIF\r\n",1000,function r(d) {
      if (d=="OK") callback(null, devs);
      else if (d===undefined || d=="ERROR") callback("Error");
      else {
        var e = d.split(",");
        devs.push({ip:e[0], mac:e[1]});
        return r;
      }
    });
  },
  "getIP" : function(callback) {
    var ip;
    at.cmdReg("AT+CIFSR\r\n", 1000, "+CIFSR", function(d) {
      if (!ip && d.indexOf(',')>=0) ip=JSON.parse(d.slice(d.indexOf(',')+1));
    }, function(d) {
      if (d!="OK") callback("CIFSR failed: "+d);
      else callback(null, ip);
    });
  },
  "transmitFile" : function(host, port, filename, callback) {
    // Set up a TCP connection
    at.cmd('AT+CIPSTART="TCP","' + host +'",' + port + '\r\n', 10000, function cb(cipstart) {
      if (cipstart=="CONNECT") return cb;
      if (cipstart!="OK")
      {
        callback("CIPSTART failed")
      } else at.cmd("AT+CIPMODE=1\r\n", 1000, function cb(cipmode) {
        // CIPMODE=1 is wifi-passthrough mode
        if (cipmode!="OK")
        {
          setTimeout(callback,0,"CIPMODE failed");
        }
        else {
          at.cmd("AT+CIPSEND\r\n", 1000, function (cipsend) {
            // Start wifi-passthrough transmission, until a single packet containing
            // "+++" is sent.
            if (cipsend!="OK") {
              setTimeout(callback,0,"CIPSEND failed");
            } else {
              var f;
              try {
                f = E.openFile(filename, "r");
              } catch (err) {
                callback("Could not open file: ", filename);
              }
              
              if (f) {
                sendMoreData(f, my_usart, function cb(res) {
                  at.cmd("AT+CIPCLOSE\r\n", 1000, function cb2(cipclose) {
                    if (cipclose==">CLOSED") return cb2;
                    if (cipclose=="OK") {
                      callback("OK")
                    }
                  })
                }, false);
              }
            }
          })
        }
      });
    });
  },
  /*  Set the name of the access point */
  "setHostname" : function(hostname, callback) {
      at.cmd("AT+CWHOSTNAME="+JSON.stringify(hostname)+"\r\n",500,callback);
  },
  /* Ping the given address. Callback is called with the ping time
  in milliseconds, or undefined if there is an error */
  "ping" : function(addr, callback) {
    var time;
    at.cmd('AT+PING="'+addr+'"\r\n',1000,function cb(d) {
      if (d && d[0]=="+") {
        time=d.substr(1);
        return cb;
      } else if (d=="OK") callback(time); else callback();
    });
  }
};

/*
 *  Function that handles the transmission of a file in wifi-passthrough mode
 *  Parameters
 *    f - file object of file to send
 *    ser - serial port
 *    cb - callback to call when complete
 *    finish - used to signal that all data is sent, and that wifi-passthrough should be exited
 */
function sendMoreData(f, ser, cb, finish) {
  
  if (finish) {
    // To exist from wifi-passthrough mode, a single packet containing
    //"+++" is sent.
    ser.print("+++");
    // call callback after 1s, since that's the time it takes
    // until ESP8266 is ready after sending "+++"
    setTimeout(cb, 1000, "OK");
    return;
  }

  var d = f.read(2048)
  var len = d ? d.length : 0
  
  if (d) ser.write(d)

  if (len != 2048) {
    // If we didn't get 2048 bytes of data, we're at the end of the file
    setTimeout(sendMoreData, 1000, f, ser, cb, true);
  } else {
    // Docs say to leave 20 ms between writes
    setTimeout(sendMoreData, 20, f, ser, cb, false);
  }
}

exports.connect = function(usart, connectedCallback) {
  wifiFuncs.at = at = require("AT").connect(usart);
  my_usart = usart;

  //at.register("+IPD", ipdHandler);
  at.registerLine("WIFI CONNECTED", function() { exports.emit("associated"); });
  at.registerLine("WIFI GOT IP", function() { exports.emit("connected"); });
  at.registerLine("WIFI DISCONNECTED", function() { exports.emit("disconnected"); });

  wifiFuncs.reset(connectedCallback);

  return wifiFuncs;
};
