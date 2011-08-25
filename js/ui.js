/*
 * noVNC: HTML5 VNC client
 * Copyright (C) 2011 Joel Martin
 * Licensed under LGPL-3 (see LICENSE.txt)
 *
 * See README.md for usage and integration instructions.
 */

"use strict";
/*jslint white: false, browser: true */
/*global window, $D, Util, WebUtil, RFB, Display */

var UI = {

settingsOpen : false,

// Render default UI and initialize settings menu
load: function() {
    var html = '', i, sheet, sheets, llevels;

    // Stylesheet selection dropdown
    html = '              <option value="default">default</option>';
    sheet = WebUtil.selectStylesheet();
    sheets = WebUtil.getStylesheets();
    for (i = 0; i < sheets.length; i += 1) {
        html += '<option value="' + sheets[i].title + '">' + sheets[i].title + '</option>';
    }
    $D('noVNC_stylesheet').innerHTML = html;

    // Logging selection dropdown
    html = '';
    llevels = ['error', 'warn', 'info', 'debug'];
    for (i = 0; i < llevels.length; i += 1) {
        html += '<option value="' + llevels[i] + '">' + llevels[i] + '</option>';
    }
    $D('noVNC_logging').innerHTML = html;

    // Settings with immediate effects
    UI.initSetting('logging', 'warn');
    WebUtil.init_logging(UI.getSetting('logging'));
    UI.initSetting('stylesheet', 'default');

    WebUtil.selectStylesheet(null); // call twice to get around webkit bug
    WebUtil.selectStylesheet(UI.getSetting('stylesheet'));

    /* Populate the controls if defaults are provided in the URL */
    UI.initSetting('host', '');
    UI.initSetting('port', '');
    UI.initSetting('password', '');
    UI.initSetting('encrypt', false);
    UI.initSetting('true_color', true);
    UI.initSetting('cursor', false);
    UI.initSetting('shared', true);
    UI.initSetting('connectTimeout', 2);

    UI.rfb = RFB({'target': $D('noVNC_canvas'),
                  'onUpdateState': UI.updateState,
                  'onClipboard': UI.clipReceive});

    // Unfocus clipboard when over the VNC area
    /*
    $D('noVNC_screen').onmousemove = function () {
            var keyboard = UI.rfb.get_keyboard();
            if ((! keyboard) || (! keyboard.get_focused())) {
                $D('noVNC_clipboard_text').blur();
            }
        };
    */

    // Show mouse selector buttons on touch screen devices
    if ('ontouchstart' in document.documentElement) {
        $D('noVNC_mouse_buttons').style.display = "inline";
        UI.setMouseButton();
    }

},

// Read form control compatible setting from cookie
getSetting: function(name) {
    var val, ctrl = $D('noVNC_' + name);
    val = WebUtil.readCookie(name);
    if (ctrl.type === 'checkbox') {
        if (val.toLowerCase() in {'0':1, 'no':1, 'false':1}) {
            val = false;
        } else {
            val = true;
        }
    }
    return val;
},

// Update cookie and form control setting. If value is not set, then
// updates from control to current cookie setting.
updateSetting: function(name, value) {
    var i, ctrl = $D('noVNC_' + name);
    // Save the cookie for this session
    if (typeof value !== 'undefined') {
        WebUtil.createCookie(name, value);
    }

    // Update the settings control
    value = UI.getSetting(name);
    if (ctrl.type === 'checkbox') {
        ctrl.checked = value;
    } else if (typeof ctrl.options !== 'undefined') {
        for (i = 0; i < ctrl.options.length; i += 1) {
            if (ctrl.options[i].value === value) {
                ctrl.selectedIndex = i;
                break;
            }
        }
    } else {
        ctrl.value = value;
    }
},

// Save control setting to cookie
saveSetting: function(name) {
    var val, ctrl = $D('noVNC_' + name);
    if (ctrl.type === 'checkbox') {
        val = ctrl.checked;
    } else if (typeof ctrl.options !== 'undefined') {
        val = ctrl.options[ctrl.selectedIndex].value;
    } else {
        val = ctrl.value;
    }
    WebUtil.createCookie(name, val);
    //Util.Debug("Setting saved '" + name + "=" + val + "'");
    return val;
},

// Initial page load read/initialization of settings
initSetting: function(name, defVal) {
    var val;

    // Check Query string followed by cookie
    val = WebUtil.getQueryVar(name);
    if (val === null) {
        val = WebUtil.readCookie(name, defVal);
    }
    UI.updateSetting(name, val);
    //Util.Debug("Setting '" + name + "' initialized to '" + val + "'");
    return val;
},


// Toggle the settings menu:
//   On open, settings are refreshed from saved cookies.
//   On close, settings are applied
clickSettingsMenu: function() {
    if (UI.settingsOpen) {
        UI.settingsApply();

        UI.closeSettingsMenu();
    } else {
        UI.updateSetting('encrypt');
        UI.updateSetting('true_color');
        if (UI.rfb.get_display().get_cursor_uri()) {
            UI.updateSetting('cursor');
        } else {
            UI.updateSetting('cursor', false);
            $D('noVNC_cursor').disabled = true;
        }
        UI.updateSetting('shared');
        UI.updateSetting('connectTimeout');
        UI.updateSetting('stylesheet');
        UI.updateSetting('logging');

        UI.openSettingsMenu();
    }
},

// Open menu
openSettingsMenu: function() {
    $D('noVNC_settings_menu').style.display = "block";
    UI.settingsOpen = true;
},

// Close menu (without applying settings)
closeSettingsMenu: function() {
    $D('noVNC_settings_menu').style.display = "none";
    UI.settingsOpen = false;
},

// Disable/enable controls depending on connection state
settingsDisabled: function(disabled, rfb) {
    //Util.Debug(">> settingsDisabled");
    $D('noVNC_encrypt').disabled = disabled;
    $D('noVNC_true_color').disabled = disabled;
    if (rfb && rfb.get_display() && rfb.get_display().get_cursor_uri()) {
        $D('noVNC_cursor').disabled = disabled;
    } else {
        UI.updateSetting('cursor', false);
        $D('noVNC_cursor').disabled = true;
    }
    $D('noVNC_shared').disabled = disabled;
    $D('noVNC_connectTimeout').disabled = disabled;
    //Util.Debug("<< settingsDisabled");
},

// Save/apply settings when 'Apply' button is pressed
settingsApply: function() {
    //Util.Debug(">> settingsApply");
    UI.saveSetting('encrypt');
    UI.saveSetting('true_color');
    if (UI.rfb.get_display().get_cursor_uri()) {
        UI.saveSetting('cursor');
    }
    UI.saveSetting('shared');
    UI.saveSetting('connectTimeout');
    UI.saveSetting('stylesheet');
    UI.saveSetting('logging');

    // Settings with immediate (non-connected related) effect
    WebUtil.selectStylesheet(UI.getSetting('stylesheet'));
    WebUtil.init_logging(UI.getSetting('logging'));

    //Util.Debug("<< settingsApply");
},



setPassword: function() {
    UI.rfb.sendPassword($D('noVNC_password').value);
    return false;
},

sendCtrlAltDel: function() {
    UI.rfb.sendCtrlAltDel();
},

setMouseButton: function(num) {
    var b, blist = [1,2,4], button,
        mouse = UI.rfb.get_mouse();

    if (typeof num === 'undefined') {
        // Show the default
        num = mouse.get_touchButton();
    } else if (num === mouse.get_touchButton()) {
        // Set all buttons off (no clicks)
        mouse.set_touchButton(0);
        num = 0;
    } else {
        // Turn on one button
        mouse.set_touchButton(num);
    }

    for (b = 0; b < blist.length; b++) {
        button = $D('noVNC_mouse_button' + blist[b]);
        if (blist[b] === num) {
            button.style.backgroundColor = "black";
            button.style.color = "lightgray";
        } else {
            button.style.backgroundColor = "";
            button.style.color = "";
        }
    }

},

updateState: function(rfb, state, oldstate, msg) {
    var s, sb, c, cad, klass;
    s = $D('noVNC_status');
    c = $D('noVNC_connect_button');
    cad = $D('sendCtrlAltDelButton');
    switch (state) {
        case 'failed':
        case 'fatal':
            c.disabled = true;
            cad.disabled = true;
            UI.settingsDisabled(true, rfb);
            klass = "noVNC-status-error";
            break;
        case 'normal':
            c.value = "Disconnect";
            c.onclick = UI.disconnect;
            c.disabled = false;
            cad.disabled = false;
            UI.settingsDisabled(true, rfb);
            klass = "noVNC-status-normal";
            break;
        case 'disconnected':
        case 'loaded':
            c.value = "Connect";
            c.onclick = UI.connect;

            c.disabled = false;
            cad.disabled = true;
            UI.settingsDisabled(false, rfb);
            klass = "noVNC-status-normal";
            break;
        case 'password':
            c.value = "Send Password";
            c.onclick = UI.setPassword;

            c.disabled = false;
            cad.disabled = true;
            UI.settingsDisabled(true, rfb);
            klass = "noVNC-status-warn";
            break;
        default:
            c.disabled = true;
            cad.disabled = true;
            UI.settingsDisabled(true, rfb);
            klass = "noVNC-status-warn";
            break;
    }

    if (typeof(msg) !== 'undefined') {
        s.setAttribute("class", klass);
        s.innerHTML = msg;
    }

},

clipReceive: function(rfb, text) {
    Util.Debug(">> UI.clipReceive: " + text.substr(0,40) + "...");
    $D('noVNC_clipboard_text').value = text;
    Util.Debug("<< UI.clipReceive");
},


connect: function() {
    var host, port, password;

    UI.closeSettingsMenu();

    host = $D('noVNC_host').value;
    port = $D('noVNC_port').value;
    password = $D('noVNC_password').value;
    if ((!host) || (!port)) {
        throw("Must set host and port");
    }

    UI.rfb.set_encrypt(UI.getSetting('encrypt'));
    UI.rfb.set_true_color(UI.getSetting('true_color'));
    UI.rfb.set_local_cursor(UI.getSetting('cursor'));
    UI.rfb.set_shared(UI.getSetting('shared'));
    UI.rfb.set_connectTimeout(UI.getSetting('connectTimeout'));

    UI.rfb.connect(host, port, password);
},

disconnect: function() {
    UI.closeSettingsMenu();

    UI.rfb.disconnect();
},

displayBlur: function() {
    UI.rfb.get_keyboard().set_focused(false);
    UI.rfb.get_mouse().set_focused(false);
},

displayFocus: function() {
    UI.rfb.get_keyboard().set_focused(true);
    UI.rfb.get_mouse().set_focused(true);
},

clipClear: function() {
    $D('noVNC_clipboard_text').value = "";
    UI.rfb.clipboardPasteFrom("");
},

clipSend: function() {
    var text = $D('noVNC_clipboard_text').value;
    Util.Debug(">> UI.clipSend: " + text.substr(0,40) + "...");
    UI.rfb.clipboardPasteFrom(text);
    Util.Debug("<< UI.clipSend");
}

};
