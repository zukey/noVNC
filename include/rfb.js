/*
 * noVNC: HTML5 VNC client
 * Copyright (C) 2012 Joel Martin
 * Licensed under MPL 2.0 (see LICENSE.txt)
 *
 * See README.md for usage and integration instructions.
 *
 * TIGHT decoder portion:
 * (c) 2012 Michael Tinglof, Joe Balaz, Les Piech (Mercuri.ca)
 */

/*jslint white: false, browser: true, bitwise: false, plusplus: false */
/*global window, Util, Display, Keyboard, Mouse, Websock, Websock_native, Base64, DES */


function RFB(defaults) {
"use strict";

var that           = {},  // Public API methods
    conf           = {},  // Configuration attributes

    // Pre-declare private functions used before definitions (jslint)
    init_vars, updateState, fail, handle_message,
    framebufferUpdate, print_stats,

    getTightCLength, extract_data_uri,
    keyPress, mouseButton, mouseMove,

    checkEvents,  // Overridable for testing

    bencode, bdecode, encode_packet, decode_packet,


    //
    // Private RFB namespace variables
    //
    rfb_host       = '',
    rfb_port       = 5900,
    rfb_password   = '',
    rfb_path       = '',

    rfb_state      = 'disconnected',
    rfb_version    = 0,
    rfb_max_version= 3.8,
    rfb_auth_scheme= '',


    packetHandlers = {},

    encHandlers    = {},
    encNames       = {}, 
    encStats       = {},     // [rectCnt, rectCntTot]

    ws             = null,   // Websock object
    display        = null,   // Display object
    keyboard       = null,   // Keyboard input handler object
    mouse          = null,   // Mouse input handler object
    sendTimer      = null,   // Send Queue check timer
    connTimer      = null,   // connection timer
    disconnTimer   = null,   // disconnection timer
    msgTimer       = null,   // queued handle_message timer

    zlib           = null,   // zlib encoder/decoder

    windows        = {},     // managed windows

    send_packets   = [],     // pending packets to send (mouse movements)

    raw_packets    = {},     // partially received raw packets

    cur_packet_recv_time = 0, // record when we received the packet we are currently handling

    keycodes       = {},

    stats          = {
        last_ping_echoed_time: 0,
        server_ping_latency: [],
        client_ping_latency: [] 
    },

    fb_Bpp         = 4,
    fb_depth       = 3,
    fb_width       = 0,
    fb_height      = 0,
    fb_name        = "",

    last_req_time  = 0,
    rre_chunk_sz   = 100,

    timing         = {
        last_fbu       : 0,
        fbu_total      : 0,
        fbu_total_cnt  : 0,
        full_fbu_total : 0,
        full_fbu_cnt   : 0,

        fbu_rt_start   : 0,
        fbu_rt_total   : 0,
        fbu_rt_cnt     : 0,
        pixels         : 0
    },

    test_mode        = false,

    def_con_timeout  = Websock_native ? 2 : 5,

    /* Mouse state */
    mouse_buttonMask = 0,
    mouse_arr        = [],
    viewportDragging = false,
    viewportDragPos  = {};

// Configuration attributes
Util.conf_defaults(conf, that, defaults, [
    ['target',             'wo', 'dom', null, 'VNC display rendering Canvas object'],
    ['focusContainer',     'wo', 'dom', document, 'DOM element that captures keyboard input'],

    ['encrypt',            'rw', 'bool', false, 'Use TLS/SSL/wss encryption'],
    ['true_color',         'rw', 'bool', true,  'Request true color pixel data'],
    ['local_cursor',       'rw', 'bool', false, 'Request locally rendered cursor'],
    ['shared',             'rw', 'bool', true,  'Request shared mode'],
    ['view_only',          'rw', 'bool', false, 'Disable client mouse/keyboard'],

    ['connectTimeout',     'rw', 'int', def_con_timeout, 'Time (s) to wait for connection'],
    ['disconnectTimeout',  'rw', 'int', 3,    'Time (s) to wait for disconnection'],

    // UltraVNC repeater ID to connect to
    ['repeaterID',         'rw', 'str',  '',    'RepeaterID to connect to'],

    ['viewportDrag',       'rw', 'bool', false, 'Move the viewport on mouse drags'],

    ['check_rate',         'rw', 'int', 217,  'Timing (ms) of send/receive check'],
    ['ping_rate',          'rw', 'int', 10000,  'Timing (ms) of ping sending'],

    // Callback functions
    ['onUpdateState',      'rw', 'func', function() { },
        'onUpdateState(rfb, state, oldstate, statusMsg): RFB state update/change '],
    ['onPasswordRequired', 'rw', 'func', function() { },
        'onPasswordRequired(rfb): VNC password is required '],
    ['onClipboard',        'rw', 'func', function() { },
        'onClipboard(rfb, text): RFB clipboard contents received'],
    ['onBell',             'rw', 'func', function() { },
        'onBell(rfb): RFB Bell message received '],
    ['onFBUReceive',       'rw', 'func', function() { },
        'onFBUReceive(rfb, fbu): RFB FBU received but not yet processed '],
    ['onFBUComplete',      'rw', 'func', function() { },
        'onFBUComplete(rfb, fbu): RFB FBU received and processed '],
    ['onFBResize',         'rw', 'func', function() { },
        'onFBResize(rfb, width, height): frame buffer resized'],

    // These callback names are deprecated
    ['updateState',        'rw', 'func', function() { },
        'obsolete, use onUpdateState'],
    ['clipboardReceive',   'rw', 'func', function() { },
        'obsolete, use onClipboard']
    ]);


// Override/add some specific configuration getters/setters
that.set_local_cursor = function(cursor) {
    if ((!cursor) || (cursor in {'0':1, 'no':1, 'false':1})) {
        conf.local_cursor = false;
    } else {
        if (display.get_cursor_uri()) {
            conf.local_cursor = true;
        } else {
            Util.Warn("Browser does not support local cursor");
        }
    }
};

// These are fake configuration getters
that.get_display = function() { return display; };

that.get_keyboard = function() { return keyboard; };

that.get_mouse = function() { return mouse; };


//
// Setup routines
//

// Create the public API interface and initialize values that stay
// constant across connect/disconnect
function constructor() {
    var i, rmode;
    Util.Debug(">> RFB.constructor");

    // Initialize display, mouse, keyboard, and websock
    try {
        display   = new Display({'target': conf.target});
    } catch (exc) {
        Util.Error("Display exception: " + exc);
        updateState('fatal', "No working Display");
    }
    keyboard = new Keyboard({'target': conf.focusContainer,
                                'onKeyPress': keyPress});
    mouse    = new Mouse({'target': conf.target,
                            'onMouseButton': mouseButton,
                            'onMouseMove': mouseMove});

    rmode = display.get_render_mode();

    ws = new Websock();
    ws.on('message', handle_message);
    ws.on('open', function() {
        Util.Info("connected")
        if (rfb_state === "connect") {
            ws.send(helloPacket());
            updateState('hello', "Starting Xpra handshake");
        } else {
            fail("Got unexpected WebSockets connection");
        }
    });
    ws.on('close', function(e) {
        Util.Warn("WebSocket on-close event");
        var msg = "";
        if (e.code) {
            msg = " (code: " + e.code;
            if (e.reason) {
                msg += ", reason: " + e.reason;
            }
            msg += ")";
        }
        if (rfb_state === 'disconnect') {
            updateState('disconnected', 'VNC disconnected' + msg);
        } else if (rfb_state === 'ProtocolVersion') {
            fail('Failed to connect to server' + msg);
        } else if (rfb_state in {'failed':1, 'disconnected':1}) {
            Util.Error("Received onclose while disconnected" + msg);
        } else  {
            fail('Server disconnected' + msg);
        }
    });
    ws.on('error', function(e) {
        Util.Warn("WebSocket on-error event");
        //fail("WebSock reported an error");
    });


    init_vars();

    /* Check web-socket-js if no builtin WebSocket support */
    if (Websock_native) {
        Util.Info("Using native WebSockets");
        updateState('loaded', 'noVNC ready: native WebSockets, ' + rmode);
    } else {
        Util.Warn("Using web-socket-js bridge. Flash version: " +
                  Util.Flash.version);
        if ((! Util.Flash) ||
            (Util.Flash.version < 9)) {
            updateState('fatal', "WebSockets or <a href='http://get.adobe.com/flashplayer'>Adobe Flash<\/a> is required");
        } else if (document.location.href.substr(0, 7) === "file://") {
            updateState('fatal',
                    "'file://' URL is incompatible with Adobe Flash");
        } else {
            updateState('loaded', 'noVNC ready: WebSockets emulation, ' + rmode);
        }
    }

    Util.Debug("<< RFB.constructor");
    return that;  // Return the public API interface
}

function connect() {
    Util.Debug(">> RFB.connect");
    var uri;
    
    if (typeof UsingSocketIO !== "undefined") {
        uri = "http://" + rfb_host + ":" + rfb_port + "/" + rfb_path;
    } else {
        if (conf.encrypt) {
            uri = "wss://";
        } else {
            uri = "ws://";
        }
        uri += rfb_host + ":" + rfb_port + "/" + rfb_path;
    }
    Util.Info("connecting to " + uri);
    // TODO: make protocols a configurable
    ws.open(uri, ['binary', 'base64']);

    Util.Debug("<< RFB.connect");
}

// Initialize variables that are reset before each connection
init_vars = function() {
    var i;

    /* Reset state */
    ws.init();

    mouse_buttonMask = 0;
    mouse_arr        = [];

    zlib = new TINF();
    zlib.init();

    var keynames = {
        32:'space', 33:'exclam', 35:'numbersign', 36:'dollar',
        37:'percent', 38:'ampersand', 40:'parenleft', 41:'parenright',
        42:'asterisk', 43:'plus', 45:'minus', 61:'equal',
        94:'asciicircum', 95:'underscore',
        96:'grave', 126:'asciitilde' };

    // Symbols are wrong
    for (i=32; i < 127; i++) {
        var keyname = keynames[i] ? keynames[i] : String.fromCharCode(i);
        keycodes[i] = [i, keyname, i, 0, 0];
    }
    // Some whacky ones
    keycodes[64] = [34, 'at', 34, 0, 0];
    keycodes[126] = [126, 'asciitilde', 49, 0, 0];
    // Special codes
    keycodes[65505] = [65505, 'Shift_L', 65505, 0, 0];
    keycodes[65506] = [65506, 'Shift_R', 65506, 0, 0];
    keycodes[65507] = [65507, 'Control_L', 65507, 0, 0];
    keycodes[65508] = [65508, 'Control_R', 65508, 0, 0];
    keycodes[65513] = [65513, 'Alt_L', 65513, 0, 0];
    keycodes[65514] = [65514, 'Alt_R', 65514, 0, 0];
    keycodes[65288] = [65288, 'BackSpace', 65288, 0, 0];
    keycodes[65289] = [65289, 'Tab', 65289, 0, 0];
    keycodes[65293] = [65293, 'Return', 65293, 0, 0];
};

// Print statistics
print_stats = function() {
    var i, s;
    Util.Info("Encoding stats for this connection:");
};

//
// Utility routines
//


/*
 * Page states:
 *   loaded       - page load, equivalent to disconnected
 *   disconnected - idle state
 *   connect      - starting to connect (to ProtocolVersion)
 *   normal       - connected
 *   disconnect   - starting to disconnect
 *   failed       - abnormal disconnect
 *   fatal        - failed to load page, or fatal error
 *
 * Xpra protocol initialization states:
 *   hello
 */
updateState = function(state, statusMsg) {
    var func, cmsg, oldstate = rfb_state;

    if (state === oldstate) {
        /* Already here, ignore */
        Util.Debug("Already in state '" + state + "', ignoring.");
        return;
    }

    /* 
     * These are disconnected states. A previous connect may
     * asynchronously cause a connection so make sure we are closed.
     */
    if (state in {'disconnected':1, 'loaded':1, 'connect':1,
                  'disconnect':1, 'failed':1, 'fatal':1}) {
        if (sendTimer) {
            clearInterval(sendTimer);
            sendTimer = null;
        }

        if (msgTimer) {
            clearInterval(msgTimer);
            msgTimer = null;
        }

        if (display && display.get_context()) {
            keyboard.ungrab();
            mouse.ungrab();
            display.defaultCursor();
            if ((Util.get_logging() !== 'debug') ||
                (state === 'loaded')) {
                // Show noVNC logo on load and when disconnected if
                // debug is off
                display.clear();
            }
        }

        ws.close();
    }

    if (oldstate === 'fatal') {
        Util.Error("Fatal error, cannot continue");
    }

    if ((state === 'failed') || (state === 'fatal')) {
        func = Util.Error;
    } else {
        func = Util.Warn;
    }

    cmsg = typeof(statusMsg) !== 'undefined' ? (" Msg: " + statusMsg) : "";
    func("New state '" + state + "', was '" + oldstate + "'." + cmsg);

    if ((oldstate === 'failed') && (state === 'disconnected')) {
        // Do disconnect action, but stay in failed state
        rfb_state = 'failed';
    } else {
        rfb_state = state;
    }

    if (connTimer && (rfb_state !== 'connect')) {
        Util.Debug("Clearing connect timer");
        clearInterval(connTimer);
        connTimer = null;
    }

    if (disconnTimer && (rfb_state !== 'disconnect')) {
        Util.Debug("Clearing disconnect timer");
        clearInterval(disconnTimer);
        disconnTimer = null;
    }

    switch (state) {
    case 'normal':
        if ((oldstate === 'disconnected') || (oldstate === 'failed')) {
            Util.Error("Invalid transition from 'disconnected' or 'failed' to 'normal'");
        }

        break;


    case 'connect':
        
        connTimer = setTimeout(function () {
                fail("Connect timeout");
            }, conf.connectTimeout * 1000);

        init_vars();
        connect();

        // WebSocket.onopen transitions to 'ProtocolVersion'
        break;


    case 'disconnect':

        if (! test_mode) {
            disconnTimer = setTimeout(function () {
                    fail("Disconnect timeout");
                }, conf.disconnectTimeout * 1000);
        }

        print_stats();

        // WebSocket.onclose transitions to 'disconnected'
        break;


    case 'failed':
        if (oldstate === 'disconnected') {
            Util.Error("Invalid transition from 'disconnected' to 'failed'");
        }
        if (oldstate === 'normal') {
            Util.Error("Error while connected.");
        }
        if (oldstate === 'init') {
            Util.Error("Error while initializing.");
        }

        // Make sure we transition to disconnected
        setTimeout(function() { updateState('disconnected'); }, 50);

        break;


    default:
        // No state change action to take

    }

    if ((oldstate === 'failed') && (state === 'disconnected')) {
        // Leave the failed message
        conf.updateState(that, state, oldstate); // Obsolete
        conf.onUpdateState(that, state, oldstate);
    } else {
        conf.updateState(that, state, oldstate, statusMsg); // Obsolete
        conf.onUpdateState(that, state, oldstate, statusMsg);
    }
};

fail = function(msg) {
    updateState('failed', msg);
    return false;
};

handle_message = function() {
    //Util.Debug(">> handle_message ws.rQlen(): " + ws.rQlen());
    //Util.Debug("ws.rQslice(0,20): " + ws.rQslice(0,20) + " (" + ws.rQlen() + ")");
    if (cur_packet_recv_time === 0) {
        cur_packet_recv_time = (new Date()).getTime();
    }
    var packet = decode_packet(ws.get_rQ(), ws.get_rQi());
    if (packet.length > 0) {
        // Remove the processed data from the queue
        ws.set_rQi(ws.get_rQi() + packet.length);
    }
    if (packet.data) {
        // full packet has been received, so process it
        var ptype = packet.data[0].replace(/-/, "_"),
            handler = packetHandlers[ptype];
        if (handler) {
            handler(packet.data);
        } else {
            Util.Warn("no handler defined for packet type '" + ptype + "'");
        }
        // we got a whole packet so reset the packet received timestamp
        cur_packet_recv_time = 0;
    }

    if (ws.rQlen() >= 8) {
        // if we have at least 8 bytes remaining, then requeue
        // ourselves, but use setTimeout to give other events a chance
        // to run
        if (msgTimer === null) {
            Util.Debug("More data to process, creating timer");
            msgTimer = setTimeout(function () {
                        msgTimer = null;
                        handle_message();
                    }, 1);
        } else {
            Util.Debug("More data to process, existing timer");
        }
    }
};


function flushClient() {
    if (send_packets.length > 0) {
        for (var i=0; i < send_packets.length; i++) {
            ws.send(send_packets[i]);
        }
        send_packets  = [];
        return true;
    } else {
        return false;
    }
}

// overridable for testing
checkEvents = function() {
    var now;
    if (rfb_state === 'normal' && !viewportDragging) {
        flushClient();
    }
    setTimeout(checkEvents, conf.check_rate);
};

keyPress = function(keysym, down, evt) {
    var arr, packet;

    if (conf.view_only) { return; } // View only, skip keyboard events

    packet = keyActionPacket(1, keysym, down, evt)

    if (!packet) { return false; }

    send_packets.push(packet);
    flushClient();
};

mouseButton = function(x, y, down, bmask) {
    if (down) {
        mouse_buttonMask |= bmask;
    } else {
        mouse_buttonMask ^= bmask;
    }

    if (conf.viewportDrag) {
        if (down && !viewportDragging) {
            viewportDragging = true;
            viewportDragPos = {'x': x, 'y': y};

            // Skip sending mouse events
            return;
        } else {
            viewportDragging = false;
            ws.send(fbUpdateRequests()); // Force immediate redraw
        }
    }

    if (conf.view_only) { return; } // View only, skip mouse events

    var button = 1;  // TODO: translate bmask to button #
    send_packets.push(pointerActionPacket(
                1, button, down, display.absX(x), display.absY(y)));
    flushClient();
};

mouseMove = function(x, y) {
    Util.Debug('>> mouseMove ' + x + "," + y);
    var deltaX, deltaY;

    if (viewportDragging) {
        //deltaX = x - viewportDragPos.x; // drag viewport
        deltaX = viewportDragPos.x - x; // drag frame buffer
        //deltaY = y - viewportDragPos.y; // drag viewport
        deltaY = viewportDragPos.y - y; // drag frame buffer
        viewportDragPos = {'x': x, 'y': y};

        display.viewportChange(deltaX, deltaY);

        // Skip sending mouse events
        return;
    }

    if (conf.view_only) { return; } // View only, skip mouse events

    send_packets.push(pointerPositionPacket(
                1, display.absX(x), display.absY(y)));
};


//
// Xpra protocol routines
//

function bencode(data) {
    switch (typeof(data)) {
    case "number":
        return "i" + data + "e";
        break;
    case "string":
        return data.length + ":" + data;
        break;
    case "object":
        if (Array.isArray(data)) {
            var res = "l";
            for (var i = 0; i < data.length; i++) {
                res += bencode(data[i]);
            }
            return res + "e";
        } else {
            var res = "d",
                keys = Object.keys(data).sort();
            for (var i = 0; i < keys.length; i++) {
                var k = keys[i],
                    v = data[k];
                res += bencode(k);
                res += bencode(v);
            }
            return res + "e";
        }
        break;
    default:
        throw("Unknown encode_data type: " + typeof(data));
    } 
}

function bdecode(raw, f) {
    var ret, res;
    f = (typeof(f) === "undefined") ? 0 : f;
    switch (raw[f]) {
    case 'i':
        var end = raw.indexOf('e', f+1);
        if (end < 0) {
            throw("Error decoding integer value");
        }
        var num = parseInt(raw.substring(f+1, end), 10);
        res = num;
        f = end;
        break;
    case 'l':
        res = [];
        f += 1;
        while (raw[f] !== 'e') {
            ret = bdecode(raw, f);
            res.push(ret[0]);
            f = ret[1];
        }
        break;
    case 'd':
        var k, lastkey = null;
        res = {};
        f += 1;
        while (raw[f] !== 'e') {
            ret = bdecode(raw, f);
            k = ret[0];
            f = ret[1];
            if (lastkey !== null && lastkey >= k) {
                throw("Unsorted keys found while decoding dict type");
            }
            lastkey = k;
            ret = bdecode(raw, f);
            res[k] = ret[0];
            f = ret[1];
        }
        break;
    default:
        if (!raw[f].match(/^[0-9]/)) {
            throw("Unknown decoding type: " + raw[f]);
        }
        var end = raw.indexOf(':', f+1);
        if (end < 0) {
            throw("Error decoding string value");
        }
        var len = parseInt(raw.substring(f, end), 10);
        res = raw.substr(end+1, len);
        f = end+len;
    }
    return [res, f+1];
}

/*
function encode_packet(data) {
    var encoded_data = bencode(data),
        payload_size = encoded_data.length,
        packet_size = 8 + payload_size + (4-payload_size%4),
        packet8 = new Uint8Array(packet_size),
        payload8 = new Uint8Array(packet8.buffer, 8),
        packet32 = new Uint32Array(packet8.buffer, 0);

    packet8[0] = 80;            // 'P'.charCodeAt(0)
    packet8[1] = 0;             // protocol flags
    packet8[2] = 0;             // compression level
    packet8[3] = 0;             // packet index
    packet32[1] = payload_size; // packet payload size

    for (var i=0; i < payload_size; i++) {
        payload8[i] = encoded_data.charCodeAt(i);
    }

    console.log("packet8: ", packet8, ", payload: ", encoded_data);
    return packet8;
}
*/

function encode_packet(data) {
    //console.log("send packet data:", data);
    var encoded_data = bencode(data),
        payload_size = encoded_data.length,
        packet = [];

    packet.push8(80);            // 'P'.charCodeAt(0)
    packet.push8(0);             // protocol flags
    packet.push8(0);             // compression level
    packet.push8(0);             // packet index
    packet.push32(payload_size); // packet payload size

    // Convert to array
    // TODO: remmove this step
    for (var i=0; i < payload_size; i++) {
        packet.push8(encoded_data.charCodeAt(i));
    }

    return packet;
}

var inflate = function(data, offset) {
    zlib.reset();
    var inflated = zlib.uncompress(data, offset);
    if (inflated.status !== 0) {
        throw("Invalid data in zlib stream");
    }
    return inflated.data;
};

function decode_packet(arr, idx) {
    var packet = {};
    idx = (typeof(idx) === "undefined") ? 0 : idx;
    if (arr.length - idx < 8) {
        return {'length': 0};
    }
    packet.magic = arr[idx];
    packet.flags = arr[idx+1];
    packet.level = arr[idx+2];
    packet.index = arr[idx+3];
    packet.size  = (arr[idx+4] << 24) +
                (arr[idx+5] << 16) +
                (arr[idx+6] << 8) +
                (arr[idx+7]);
    packet.length = 8 + packet.size;
    packet.data = null;
    if (arr.length - idx < packet.length) {
        return {'length': 0};
    }

    var new_arr, offset = idx + 8;
    if (packet.level > 0) {
        new_arr = inflate(arr, offset);
    } else {
        // Convert to string
        // TODO: remove this step
        new_arr = arr.slice(offset, offset + packet.size);
    }
    var str = String.fromCharCode.apply(null, new_arr);

    if (packet.index > 0) {
        raw_packets[packet.index] = str;
        // packet.data stays null indicating incomplete packet
    } else {
        packet.data = bdecode(str, 0)[0];
        // Insert any raw packets into place
        for (var idx in raw_packets) {
            packet.data[idx] = raw_packets[idx];
        }
        raw_packets = {};
    }
    return packet;

}

//
// Client packet generation routines
//

function helloPacket () {
    var flat_keycodes = [],
        capabilities;
    for(var code in keycodes) {
        flat_keycodes.push(keycodes[code]);
    }
    capabilities = {'encoding': 'png',
                    'encodings': ['png', 'jpeg'],
                    'version': '0.9.0',
                    'xkbmap_keycodes': flat_keycodes};
    return encode_packet(['hello', capabilities]);
}

function keyActionPacket(wid, keysym, down, evt) {
    var keydata = keycodes[keysym],
        keyname = "",
        modifiers = [],
        keyval = 0,
        str = "",             // not used
        keycode = 0,
        group = 0,            // not used
        is_modifier = 0;      // not used
    if (!keydata) {
        Util.Warn("ignoring undefined keysym " + keysym + " full event: " + evt);
        return false;
    }
    keyname = keydata[1];
    keyval = keydata[0];
    keycode = keydata[2];
    if (evt.shiftKey) {
        modifiers.push('shift');
    }
    if (evt.ctrlKey) {
        modifiers.push('control');
    }
    if (evt.altKey) {
        modifiers.push('alt');
    }
    Util.Info("send key-action for window " + wid + ", keyname: " + keyname + ", keyval: " + keyval + ", modifiers: " + modifiers);
    return encode_packet(['key-action', wid, keyname, down,
            modifiers, keyval, str, keycode, group, is_modifier]);
}

function pointerPositionPacket(wid, x, y) {
    var modifiers = [],
        buttons = [],
        rx = windows[wid].x + x,
        ry = windows[wid].y + y;
    return encode_packet(['pointer-position', wid,
            [rx, ry], modifiers, buttons]);
}

function pointerActionPacket(wid, button, down, x, y) {
    var modifiers = [],
        buttons = [],
        rx = windows[wid].x + x,
        ry = windows[wid].y + y;
    return encode_packet(['button-action', wid, button, down,
            [rx, ry], modifiers, buttons]);
}

function pingPacket() {
    var now_ms = (new Date()).getTime();
    Util.Info("send ping now_ms: " + now_ms);
    return encode_packet(['ping', now_ms]);
}

//
//
//

function send_ping () {
    ws.send(pingPacket());
    if (rfb_state === 'normal') {
        setTimeout(send_ping, conf.ping_rate);
    }
}

//
// Server packet receive handlers
//

packetHandlers.hello = function process_hello (data) {
    Util.Info("got hello: " + data);
    ws.send(encode_packet(["set_deflate", 0]));
    updateState('normal', "Connected");

    /* Start pushing/polling */
    setTimeout(checkEvents, conf.check_rate);

    /* Start sending pings to the server */
    send_ping();
};

packetHandlers.new_window = function process_new_window (data) {
    Util.Info("got new-window: " + data);
    var wid = data[1],
        x = data[2],
        y = data[3],
        w = data[4],
        h = data[5],
        props = data[6],
        loc = data[7];
    if (wid !== 1) {
        // TODO: don't ignore other windows
        Util.Warn("ignoring new-window for window ID " + wid);
        return;
    }

    if (w !== fb_width || h !== fb_height) {
        fb_width = w;
        fb_height = h;
        conf.onFBResize(that, fb_width, fb_height);
        display.resize(fb_width, fb_height);
        timing.fbu_rt_start = (new Date()).getTime();
    }

    windows[wid] = {x: x, y: y, w: w, h: h, props: props, loc: loc};
    //ws.send(encode_packet(["configure-window", wid, x, y, w, h, loc]));
    ws.send(encode_packet(["map-window", wid, x, y, w, h, loc]));
    ws.send(encode_packet(["focus", wid]));

    display.resize(fb_width, fb_height);
    keyboard.grab();
    mouse.grab();

};

packetHandlers.ping_echo = function process_ping_echo (data) {
    Util.Info("got ping_echo: " + data);
    var echoedtime = data[1],
        l1 = data[2],
        l2 = data[3],
        l3 = data[4],
        cl = data[5],
        now_ms = (new Date()).getTime(),
        sl = -1;
    stats.last_ping_echoed_time = echoedtime;
    sl = now_ms - echoedtime;
    stats.server_ping_latency.push([now_ms, sl]);
    // Keep 100 entries
    if (stats.server_ping_latency.length > 100) {
        stats.server_ping_latency.splice(0, stats.server_ping_latency.length-100);
    }

    if (cl >= 0) {
        stats.client_ping_latency.push([now_ms, cl]);
        // Keep 100 entries
        if (stats.client_ping_latency.length > 100) {
            stats.client_ping_latency.splice(0, stats.client_ping_latency.length-100);
        }
    }
};

packetHandlers.ping = function process_ping (data) {
    Util.Info("got ping: " + data);
    var echotime = data[1],
        l1 = 500, l2 = 500, l3 = 500,  // fake load-averages
        sl = -1,
        sl_len = stats.server_ping_latency.length;
    if (sl_len > 0) {
        sl = stats.server_ping_latency[sl_len-1][1];
    }
    Util.Info("send ping_echo sl: " + sl);
    ws.send(encode_packet(["ping_echo", echotime,
                           l1, l2, l3, sl]));
};

packetHandlers.draw = function process_draw (data) {
    Util.Info("got draw #" + data[8] + " for window " + data[1] + ": " + data.slice(2,7));
    var wid = data[1],
        x = data[2],
        y = data[3],
        w = data[4],
        h = data[5],
        coding = data[6],
        raw = data[7],
        damage_seq = data[8],
        rowstride = data[9],
        client_opts = data[10],
        decode_time,
        img;
    if (wid !== 1) {
        // TODO: handle other windows
        Util.Warn("ignoring draw for window ID " + wid);
        return;
    }
    img = new Image();
    img.src = "data:image/" + coding + ";base64," + window.btoa(raw);
    display.renderQ_push({
            'type': 'img',
            'img': img,
            'x': x,
            'y': y});
    img = null;

    // based on _do_draw, draw_region, do_draw_region, paint_png, etc
    decode_time = ((new Date()).getTime() - cur_packet_recv_time)*1000;
    Util.Info("send damage-sequence #" + damage_seq + " for window " + wid + ", w: " + w + ", h: " + h + ", decode_time: " + decode_time);
    ws.send(encode_packet(['damage-sequence', damage_seq,
                wid, w, h, decode_time]));
};


//
// Public API interface functions
//

that.connect = function(host, port, password, path) {
    //Util.Debug(">> connect");

    rfb_host       = host;
    rfb_port       = port;
    rfb_password   = (password !== undefined)   ? password : "";
    rfb_path       = (path !== undefined) ? path : "";

    if ((!rfb_host) || (!rfb_port)) {
        return fail("Must set host and port");
    }

    updateState('connect');
    //Util.Debug("<< connect");

};

that.disconnect = function() {
    //Util.Debug(">> disconnect");
    updateState('disconnect', 'Disconnecting');
    //Util.Debug("<< disconnect");
};

// Override internal functions for testing
that.testMode = function(override_send, data_mode) {
    test_mode = true;
    that.recv_message = ws.testMode(override_send, data_mode);

    // Allow debug calls to this
    that.encode_packet = encode_packet;
    that.decode_packet = decode_packet;
    that.bdecode = bdecode;
    that.bencode = bencode;

    checkEvents = function () { /* Stub Out */ };
    that.connect = function(host, port, password) {
            rfb_host = host;
            rfb_port = port;
            rfb_password = password;
            init_vars();
            updateState('ProtocolVersion', "Starting VNC handshake");
        };
};


return constructor();  // Return the public API interface

}  // End of RFB()
