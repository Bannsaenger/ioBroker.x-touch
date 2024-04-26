/**
 *
 *      iobroker x-touch Adapter
 *
 *      Copyright (c) 2020-2024, Bannsaenger <bannsaenger@gmx.de>
 *
 *      MIT License
 *
 */

/*
 * ToDo:
 *      - when maxBanks or maxChannels changes, delete when createBank is set
 *      - resend data on group membership change
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

// Load your modules here, e.g.:
const fs = require('fs');
const udp = require('dgram');
// eslint-disable-next-line no-unused-vars
const { debug } = require('console');

const POLL_REC    = 'F0002032585400F7';
const POLL_REPLY  = 'F00000661400F7';

//const HOST_CON_QUERY = 'F000006658013031353634303730344539F7';
const HOST_CON_QUERY = 'F000006658013031353634303732393345F7';
const HOST_CON_REPLY = 'F0000066580230313536343037353D1852F7';

class XTouch extends utils.Adapter {

    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: 'x-touch',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on('objectChange', this.onObjectChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));

        // read Objects template for object generation
        this.objectsTemplate = JSON.parse(fs.readFileSync(__dirname + '/lib/objects_templates.json', 'utf8'));
        // Midi mapping
        this.midi2Objects = JSON.parse(fs.readFileSync(__dirname + '/lib/midi_mapping.json', 'utf8'));
        this.objects2Midi = {};
        // and layout
        this.consoleLayout = JSON.parse(fs.readFileSync(__dirname + '/lib/console_layout.json', 'utf8'));
        // mapping of the encoder modes to LED values
        this.encoderMapping = JSON.parse(fs.readFileSync(__dirname + '/lib/encoder_mapping.json', 'utf8'));
        // mapping of the characters in timecode display to 7-segment
        // coding is in Siekoo-Alphabet (https://fakoo.de/siekoo.html)
        // not as described in Logic Control Manual
        this.characterMapping = JSON.parse(fs.readFileSync(__dirname + '/lib/character_mapping.json', 'utf8'));

        // devices object, key is ip address. Values are connection and memberOfGroup
        this.devices = [];
        this.nextDevice = 0;                // next device index for db creation
        this.deviceGroups = [];
        this.timers = {};                   // a place to store timers
        this.timers.encoderWheels = {};     // e.g. encoder wheel reset timers by device group
        this.timers.sendDelay = undefined;  // put the timer based on the configured sendDelay here

        // Send buffer (Array of sendData objects)
        // sendData = {
        //      data: {buffer | array of buffers}
        //      address : {string}          // ipAddress
        //      port: {string | number}     // port to send back (normally 10111)
        // }
        this.sendBuffer = [];
        this.sendActive = false;            // true if data sending is ongoing right now

        // creating a udp server
        this.server = udp.createSocket('udp4');
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        const self = this;
        try {
            // Initialize your adapter here
            // Reset the connection indicator during startup
            self.setState('info.connection', false, true);

            // emits when any error occurs
            self.server.on('error', self.onServerError.bind(self));

            // emits when socket is ready and listening for datagram msgs
            self.server.on('listening', self.onServerListening.bind(self));

            // emits after the socket is closed using socket.close();
            self.server.on('close', self.onServerClose.bind(self));

            // emits on new datagram msg
            self.server.on('message', self.onServerMessage.bind(self));

            // The adapters config (in the instance object everything under the attribute 'native' is accessible via
            // this.config:

            /*
            * create a vice versa mapping in object2Midi
            */
            for (const mapping of Object.keys(self.midi2Objects)) {
                self.objects2Midi[self.midi2Objects[mapping]] = mapping;
            }
            /*
            * For every state in the system there has to be also an object of type state
            */
            for (const element of self.objectsTemplate.common) {
                await self.setObjectNotExistsAsync(element._id, element);
            }

            /*
            * create the database
            */
            await self.createDatabaseAsync();

            // Read all devices in the db
            let tempObj;
            let actDeviceNum = '-1';
            const result_state = await self.getStatesOfAsync('devices');

            for (const element of result_state) {
                const splitStringArr = element._id.split('.');

                if (splitStringArr[3] !== actDeviceNum) {
                    // next device detected
                    actDeviceNum = splitStringArr[3];
                    tempObj = await self.getStateAsync('devices.' + actDeviceNum + '.ipAddress');
                    // @ts-ignore
                    const actIpAddress = (tempObj && tempObj.val) ? tempObj.val.toString() : '';
                    tempObj = await self.getStateAsync('devices.' + actDeviceNum + '.port');
                    // @ts-ignore
                    const actPort = (tempObj && tempObj.val) ? tempObj.val.toString() : '';
                    tempObj = await self.getStateAsync('devices.' + actDeviceNum + '.memberOfGroup');
                    // @ts-ignore
                    const actMemberOfGroup = (tempObj && tempObj.val) ? tempObj.val : 0;
                    tempObj = await self.getStateAsync('devices.' + actDeviceNum + '.serialNumber');
                    // @ts-ignore
                    const actSerialNumber = (tempObj && tempObj.val) ? tempObj.val.toString() : '';
                    tempObj = await self.getStateAsync('devices.' + actDeviceNum + '.activeBank');
                    // @ts-ignore
                    const actActiveBank = (tempObj && tempObj.val) ? tempObj.val : 0;
                    tempObj = await self.getStateAsync('devices.' + actDeviceNum + '.activeBaseChannel');
                    // @ts-ignore
                    const actActiveBaseChannel = (tempObj && tempObj.val) ? tempObj.val : 0;

                    self.devices[actIpAddress] = {
                        'index' : actDeviceNum,
                        'connection' : false,               // connection must be false on system start
                        'ipAddress' : actIpAddress,
                        'port' : actPort,
                        'memberOfGroup' : actMemberOfGroup,
                        'serialNumber' : actSerialNumber,
                        'activeBank' : actActiveBank,
                        'activeBaseChannel' : actActiveBaseChannel
                    };

                    self.log.debug('X-Touch got device with ip address ' + self.devices[actIpAddress].ipAddress + ' from the db');
                }
            }

            self.nextDevice = Number(actDeviceNum) + 1;
            self.log.info('X-Touch got ' + Object.keys(self.devices).length + ' devices from the db. Next free device number: "' + self.nextDevice + '"');

            // read all states from the device groups to memory
            const device_states = await self.getStatesOfAsync('deviceGroups');
            for (const device_state of device_states) {
                self.deviceGroups[device_state._id] = device_state;
                tempObj = await self.getStateAsync(device_state._id);
                // @ts-ignore
                self.deviceGroups[device_state._id].val = (tempObj && tempObj.val !== undefined) ? tempObj.val : '';
                self.deviceGroups[device_state._id].helperBool = false;                     // used for e.g. autoToggle
                self.deviceGroups[device_state._id].helperNum = -1;                         // used for e.g. display of encoders
            }

            self.log.info('X-Touch got ' + Object.keys(self.deviceGroups).length + ' states from the db');

            // In order to get state updates, you need to subscribe to them. The following line adds a subscription for our variable we have created above.
            // Or, if you really must, you can also watch all states. Don't do this if you don't need to. Otherwise this will cause a lot of unnecessary load on the system:
            self.subscribeStates('*');

            // try to open open configured server port
            self.log.info('Bind UDP socket to: "' + self.config.bind + ':' + self.config.port + '"');
            self.server.bind(self.config.port, self.config.bind);

            // Set the connection indicator after startup
            // self.setState('info.connection', true, true);
            // set by onServerListening

            // create a timer to reset the encoder state for each device group
            for (let index = 0; index < self.config.deviceGroups; index++) {
                self.timers.encoderWheels[index] = setTimeout(self.onEncoderWheelTimeoutExceeded.bind(self, index.toString()), 1000);
            }
            // last action is to create the timer for the sendDelay and unref it immediately
            self.timers.sendDelay = setTimeout(self.deviceSendNext.bind(self, undefined, 'timer'), self.config.sendDelay || 1);
            //self.timers.sendDelay.unref();

        } catch (err) {
            self.errorHandler(err, 'onReady');
        }
    }

    /**
     * Is called to set the connection state in db and log
     * @param {string} deviceAddress
     * @param {number} port
     * @param {boolean} status
     */
    async setConnection(deviceAddress, port, status) {
        const self = this;
        try {
            if (status) {
                /*
                create new device if this is the first polling since start of adapter
                */
                if (!(deviceAddress in self.devices)) {
                    self.devices[deviceAddress] = {
                        'activeBank': 0,
                        'activeBaseChannel': 1,
                        'connection': true,
                        'ipAddress': deviceAddress,
                        'port': port,
                        'memberOfGroup': 0,
                        'serialNumber': '',
                        'index': self.nextDevice,
                    };
                    let prefix = 'devices.' + self.nextDevice.toString();
                    self.setObjectNotExists(prefix, self.objectsTemplate.device);
                    prefix += '.';
                    self.nextDevice++;
                    for (const element of self.objectsTemplate.devices) {
                        await self.setObjectNotExistsAsync(prefix + element._id, element);
                    }
                    self.log.info('X-Touch device with IP <' + deviceAddress + '> created. Is now online.');
                    await self.setStateAsync(prefix + 'ipAddress', deviceAddress, true);
                    await self.setStateAsync(prefix + 'port', port, true);
                    await self.setStateAsync(prefix + 'memberOfGroup', 0, true);
                    await self.setStateAsync(prefix + 'connection', true, true);
                    self.deviceUpdateDevice(deviceAddress);
                    if (self.devices[deviceAddress].timerDeviceInactivityTimeout) {
                        self.devices[deviceAddress].timerDeviceInactivityTimeout.refresh();
                    } else {
                        self.devices[deviceAddress].timerDeviceInactivityTimeout = setTimeout(this.onDeviceInactivityTimeoutExceeded.bind(this, deviceAddress), this.config.deviceInactivityTimeout);
                    }
                } else {        // object in db must exist. Only set state if connection changed to true
                    if (!self.devices[deviceAddress].connection) {
                        self.devices[deviceAddress].connection = true;
                        self.devices[deviceAddress].port = port;
                        self.log.info('X-Touch device with IP <' + deviceAddress + '> is now online.');
                        await self.setStateAsync('devices.' + self.devices[deviceAddress].index + '.connection', true, true);
                        await self.setStateAsync('devices.' + self.devices[deviceAddress].index + '.port', port, true);        // port can have changed
                        self.deviceUpdateDevice(deviceAddress);
                    }
                    if (self.devices[deviceAddress].timerDeviceInactivityTimeout) {
                        self.devices[deviceAddress].timerDeviceInactivityTimeout.refresh();
                    } else {
                        self.devices[deviceAddress].timerDeviceInactivityTimeout = setTimeout(this.onDeviceInactivityTimeoutExceeded.bind(this, deviceAddress), this.config.deviceInactivityTimeout);
                    }
                }
            } else {
                self.devices[deviceAddress].connection = false;
                self.log.info('X-Touch device with IP <' + deviceAddress + '> now offline.');
                await self.setStateAsync('devices.' + self.devices[deviceAddress].index + '.connection', false, true);
                if (self.devices[deviceAddress].timerDeviceInactivityTimeout) {
                    clearTimeout(self.devices[deviceAddress].timerDeviceInactivityTimeout);
                    self.devices[deviceAddress].timerDeviceInactivityTimeout = undefined;
                }
            }
        } catch (err) {
            self.errorHandler(err, 'setConnection');
        }
    }

    // Methods related to Server events
    /**
     * Is called if a server error occurs
     * @param {any} error
     */
    onServerError(error) {
        this.log.error('Server got Error: <' + error + '> closing server.');
        // Reset the connection indicator
        this.setState('info.connection', false, true);
        this.server.close();
    }

    /**
     * Is called when the server is ready to process traffic
     */
    onServerListening() {
        const addr = this.server.address();
        this.log.info('X-Touch server ready on <' + addr.address + '> port <' + addr.port + '> proto <' + addr.family + '>');

        // Set the connection indicator after server goes for listening
        this.setState('info.connection', true, true);
    }

    /**
     * Is called when the server is closed via server.close
     */
    onServerClose() {
        this.log.info('X-Touch server is closed');
    }

    /**
     * Is called when the activity timer of a device expires
     * @param {string} deviceAddress
     */
    onDeviceInactivityTimeoutExceeded(deviceAddress) {
        this.log.debug('X-Touch device "' + deviceAddress + '" reached inactivity timeout');
        this.setConnection(deviceAddress, 0, false);
    }

    /**
     * Is called when the encoder wheel values must be resetted to false
     * @param {string} deviceGroup
     */
    onEncoderWheelTimeoutExceeded(deviceGroup) {
        this.log.debug(`X-Touch encoder wheel from device group ${deviceGroup}" reached inactivity timeout`);
        this.setState(`deviceGroups.${deviceGroup}.transport.encoder.cw`, false, true);     // reset the
        this.setState(`deviceGroups.${deviceGroup}.transport.encoder.ccw`, false, true);    // state values
    }

    /**
     * Is called on new datagram msg from server
     * @param {Buffer} msg      the message content received by the server socket
     * @param {Object} info     the info for e.g. address of sending host
     */
    async onServerMessage(msg, info) {
        const self = this;
        try {
            const msg_hex = msg.toString('hex').toUpperCase();
            const memberOfGroup = self.devices[info.address] ? self.devices[info.address].memberOfGroup : '0';
            let midiMsg;
            let stepsTaken;
            let direction;

            // If a polling is received then answer the polling to hold the device online
            if (msg_hex === POLL_REC){
                self.log.silly(`X-Touch received Polling from device ${info.address}, give an reply "${self.logHexData(POLL_REPLY)}"`);

                self.setConnection(info.address, info.port, true);

                self.deviceSendData(self.fromHexString(POLL_REPLY), info.address, info.port);

            } else if (msg_hex === HOST_CON_QUERY){
                self.log.silly('X-Touch received Host Connection Query, give no reply, probably "' + self.logHexData(HOST_CON_REPLY) + '" in the future');
            } else {    // other than polling and connection setup
                self.log.debug('-> ' + msg.length + ' bytes from ' + info.address + ':' + info.port + ': <' + self.logHexData(msg_hex) + '> org: <' + msg.toString() + '>');
                midiMsg = self.parseMidiData(msg);
                let baseId;
                const actPressed = midiMsg.value === '127' ? true : false;

                switch (midiMsg.msgType) {
                    case 'NoteOff':                 // No NoteOff events for now, description wrong. Only NoteOn with dynamic 0
                        break;

                    case 'NoteOn':                  // NoteOn
                        baseId = self.midi2Objects[midiMsg.note] ? self.namespace + '.deviceGroups.' + memberOfGroup + '.' + self.midi2Objects[midiMsg.note] : '';
                        if (Number(midiMsg.note) >= 104 && Number(midiMsg.note) <= 112) {       // Fader touched, Fader 1 - 8 + Master
                            await self.handleFader(baseId , undefined, actPressed ? 'touched' : 'released', info.address);
                        } else if (Number(midiMsg.note) >= 46 && Number(midiMsg.note) <= 49) {  // fader or channel switch
                            if (actPressed) {                                                   // only on butten press, omit release
                                let action = '';
                                switch (Number(midiMsg.note)) {
                                    case 46:        // fader bank down
                                        action = 'bankDown';
                                        break;

                                    case 47:        // fader bank up
                                        action = 'bankUp';
                                        break;

                                    case 48:        // channel bank up
                                        action = 'channelDown';
                                        break;

                                    case 49:        // channel bank down
                                        action = 'channelUp';
                                        break;

                                }
                                await self.deviceSwitchChannels(action, info.address);
                            }
                        }
                        else {
                            await self.handleButton(baseId, undefined, actPressed ? 'pressed' : 'released', info.address);
                        }
                        break;

                    case 'Pitchbend':               // Pitchbend (Fader value)
                        baseId = self.namespace + '.deviceGroups.' + memberOfGroup;
                        if (Number(midiMsg.channel) > 7) {      // Master Fader
                            baseId +=  '.masterFader';
                        } else {
                            baseId +=  '.banks.0.channels.' + (Number(midiMsg.channel) + 1) + '.fader';
                        }
                        await self.handleFader(baseId, midiMsg.value, 'fader', info.address);
                        break;

                    case 'ControlChange':           // Encoders do that
                        baseId = self.namespace + '.deviceGroups.' + memberOfGroup;
                        if ((Number(midiMsg.controller) >= 16) &&
                            (Number(midiMsg.controller) <= 23)){      // Channel encoder
                            baseId +=  '.banks.0.channels.' + (Number(midiMsg.controller) - 15) + '.encoder';
                        } else {
                            baseId +=  '.transport.encoder';
                        }
                        //self.log.info(`midi message controller ${midiMsg.controller} value ${midiMsg.value}`);
                        stepsTaken = 1;
                        direction = 'cw';
                        if (midiMsg.value < 65) {
                            stepsTaken = midiMsg.value;
                        } else {
                            stepsTaken = midiMsg.value - 64;
                            direction = 'ccw';
                        }
                        await self.handleEncoder(baseId, stepsTaken, direction, info.address);
                        break;
                }
            }
        } catch (err) {
            self.errorHandler(err, 'onServerMessage');
        }
    }

    /********************************************************************************
     * handler functions to handle the values coming from the database or the device
     ********************************************************************************
     * only the fader is not allowed to be transmitted to the sending device
     * primary behaviour is correction of values and the processing of the
     * autofunction process
     ********************************************************************************/
    /**
     * handle the button events and call the sendback if someting is changed
     * @param {string} buttonId                 full button id via onStateChange
     * @param {any | null | undefined} value
     * @param {string} event                    pressed, released, fader or value (value = when called via onStateChange)
     * @param {string} deviceAddress            only chen called via onServerMessage
     */
    async handleButton(buttonId, value = undefined, event = 'value', deviceAddress = '') {
        const self = this;
        try {
            let baseId;
            let stateName = '';         // the name of the particular state when called via onStateChange
            const buttonArr = buttonId.split('.');
            let activeBank = 0;
            let activeBaseChannel = 1;
            let actStatus;
            let isDirty = false;        // if true the button states has changed and must be sent

            if (buttonId === '') {
                self.log.debug('X-Touch button not supported');
                return;
            }

            if (event === 'value') {    // when called via onStateChange there is the full button id, cut the last part for baseId
                baseId = buttonId.substr(0, buttonId.lastIndexOf('.'));
                stateName = buttonId.substr(buttonId.lastIndexOf('.') + 1);

                if (stateName === '') {
                    self.log.error('handleButton called with value and only baseId');
                    return;             // if no value part provided throw an error
                }
                switch (stateName) {

                    case 'autoToggle':
                        // ToDo: check values and write back
                        self.deviceGroups[baseId + '.autoToggle'].val = value;                  // only update the internal db
                        return;

                    case 'syncGlobal':
                        self.deviceGroups[baseId + '.syncGlobal'].val = Boolean(value);         // only update the internal db
                        return;

                    case 'flashing':
                        if (self.deviceGroups[baseId + '.flashing'].val != Boolean(value)) {    // if changed send
                            self.deviceGroups[baseId + '.flashing'].val = Boolean(value);
                            isDirty = true;
                        }
                        break;

                    case 'pressed':
                        event = value ? 'pressed' : 'released';                                 // if button press is simulated via state db
                        break;

                    default:
                        if (self.deviceGroups[baseId + '.status'].val != Boolean(value)) {      // if changed send
                            self.deviceGroups[baseId + '.status'].val = Boolean(value);
                            isDirty = true;
                        }
                }

            } else {                    // when called by midiMsg determine the real channel
                if ((deviceAddress !== '') && self.devices[deviceAddress]) {
                    activeBank = self.devices[deviceAddress].activeBank;
                    activeBaseChannel = self.devices[deviceAddress].activeBaseChannel;
                }
                if (buttonArr[4] === 'banks') {         // replace bank and baseChannel on channel buttons
                    buttonArr[5] = activeBank.toString();
                    buttonArr[7] = (Number(buttonArr[7]) + activeBaseChannel - 1).toString();
                }
                baseId = buttonArr.join('.');
            }

            const buttonName = buttonArr.length > 8 ? buttonArr[8] : '';
            const actPressed = event === 'pressed' ? true : false;

            if (buttonName === 'encoder') {                  // encoder is only pressed event
                await self.setStateAsync(baseId + '.pressed', actPressed, true);
            } else {
                actStatus = self.deviceGroups[baseId + '.status'].val;
                let setValue = actStatus;

                if (event === 'value') {

                    setValue = Boolean(value);
                    isDirty = true;

                } else {        // handle the button auto mode

                    if (self.deviceGroups[baseId + '.pressed'].val !== actPressed) {      // if status changed
                        self.deviceGroups[baseId + '.pressed'].val = actPressed;
                        await self.setStateAsync(baseId + '.pressed', actPressed, true);

                        switch (self.deviceGroups[baseId + '.autoToggle'].val) {

                            case 0:         // no auto function
                                break;

                            case 1:         // tip
                                setValue = actPressed ? true : false;
                                break;

                            case 2:         // on press
                                if (actPressed) setValue = actStatus ? false : true;
                                break;

                            case 3:         // on release
                                if (!actPressed) setValue = actStatus ? false : true;
                                break;

                            case 4:         // on press / release
                                if (actPressed && !actStatus) {
                                    setValue = true;
                                    self.deviceGroups[baseId + '.autoToggle'].helperBool = true;
                                }
                                if (!actPressed && actStatus) {
                                    if (self.deviceGroups[baseId + '.autoToggle'].helperBool) {
                                        self.deviceGroups[baseId + '.autoToggle'].helperBool = false;
                                    } else {
                                        setValue = false;
                                    }
                                }
                                break;
                        }
                    }

                    if (self.deviceGroups[baseId + '.status'].val !== setValue){      // if status changed
                        self.deviceGroups[baseId + '.status'].val = setValue;
                        await self.setStateAsync(baseId + '.status', setValue, true);
                        isDirty = true;
                    }
                }

                if (isDirty) {
                    self.sendButton(baseId);
                }
            }
        } catch (err) {
            self.errorHandler(err, 'handleButton');
        }
    }

    /**
     * handle the fader events and call the sendback if someting is changed
     * @param {string} faderId                  full fader id via onStateChange
     * @param {any | null | undefined} value
     * @param {string} event                    pressed, released or value (value = when called via onStateChange)
     * @param {string} deviceAddress            only chen called via onServerMessage
     */
    async handleFader(faderId, value = undefined, event = 'value', deviceAddress = '') {
        const self = this;
        try {
            let baseId;
            let stateName = '';         // the name of the particular state when called via onStateChange
            const faderArr = faderId.split('.');
            let activeBank = 0;
            let activeBaseChannel = 1;
            let isDirty = false;        // if true the fader states has changed and must be sent
            let locObj = self.calculateFaderValue(value, 'midiValue');

            if (faderId === '') {
                self.log.debug('X-Touch fader not supported');
                return;
            }

            if (event === 'value') {    // if called via onStateChange there is the full fader id, cut the last part for baseId
                baseId = faderId.substr(0, faderId.lastIndexOf('.'));
                stateName = faderId.substr(faderId.lastIndexOf('.') + 1);

                switch (stateName) {

                    case 'syncGlobal':
                        self.deviceGroups[baseId + '.syncGlobal'].val = Boolean(value);         // only update the internal db
                        return;

                    case 'touched':
                        self.deviceGroups[baseId + '.touched'].val = Boolean(value);            // only update the internal db
                        return;

                    case 'value':
                        locObj = self.calculateFaderValue(value, 'linValue');
                        if (self.deviceGroups[baseId + '.value'].val != locObj.linValue) {
                            self.deviceGroups[baseId + '.value'].val = locObj.linValue;
                            self.deviceGroups[baseId + '.value_db'].val = locObj.logValue;
                            isDirty = true;
                        }
                        await self.setStateAsync(baseId + '.value', Number(locObj.linValue), true);            // maybe correct the format
                        await self.setStateAsync(baseId + '.value_db', Number(locObj.logValue), true);         // update log value too
                        break;

                    case 'value_db':
                        locObj = self.calculateFaderValue(value, 'logValue');
                        if (self.deviceGroups[baseId + '.value_db'].val != locObj.logValue) {
                            self.deviceGroups[baseId + '.value_db'].val = locObj.logValue;
                            self.deviceGroups[baseId + '.value'].val = locObj.linValue;
                            isDirty = true;
                        }
                        await self.setStateAsync(baseId + '.value_db', Number(locObj.logValue), true);         // maybe correct the format
                        await self.setStateAsync(baseId + '.value', Number(locObj.linValue), true);            // update lin value too
                        break;

                    default:
                        self.log.warn('X-Touch unknown fader value: "' + faderId + '"');
                        return;
                }
            } else {                    // if called by midiMsg determine the real channel
                if ((deviceAddress !== '') && self.devices[deviceAddress]) {
                    activeBank = self.devices[deviceAddress].activeBank;
                    activeBaseChannel = self.devices[deviceAddress].activeBaseChannel;
                }
                if (faderArr[4] === 'banks') {         // replace bank and baseChannel
                    faderArr[5] = activeBank.toString();
                    faderArr[7] = (Number(faderArr[7]) + activeBaseChannel - 1).toString();
                }
                baseId = faderArr.join('.');

                if (event === 'touched') {
                    if (!self.deviceGroups[baseId + '.touched'].val) {      // if status changed
                        self.deviceGroups[baseId + '.touched'].val = true;
                        await self.setStateAsync(baseId + '.touched', true, true);
                    }
                } else if (event === 'released') {
                    if (self.deviceGroups[baseId + '.touched'].val) {       // if status changed
                        self.deviceGroups[baseId + '.touched'].val = false;
                        await self.setStateAsync(baseId + '.touched', false, true);
                    }
                } else if (event === 'fader') {

                    if (self.deviceGroups[baseId + '.value'].val != locObj.linValue) {
                        self.deviceGroups[baseId + '.value'].val = locObj.linValue;
                        await self.setStateAsync(baseId + '.value', Number(locObj.linValue), true);
                        isDirty = true;
                    }
                    if (self.deviceGroups[baseId + '.value_db'].val != locObj.logValue) {
                        self.deviceGroups[baseId + '.value_db'].val = locObj.logValue;
                        await self.setStateAsync(baseId + '.value_db', Number(locObj.logValue), true);
                        isDirty = true;
                    }

                } else {
                    self.log.error('X-Touch handleFader received unknown event: "' + event + '"');
                }
            }

            if (isDirty) {
                self.sendFader(baseId, deviceAddress, true);
            }
        } catch (err) {
            self.errorHandler(err, 'handleFader');
        }
    }

    /**
     * handle the display status and call the send back if someting is changed
     * @param {string} displayId                only when called via onStateChange
     * @param {any | null | undefined} value
     */
    async handleDisplay(displayId, value = undefined) {
        const self = this;
        try {
            const displayArr = displayId.split('.');
            const stateName = displayArr.length > 9 ? displayArr[9] : '';
            const baseId = displayId.substr(0, displayId.lastIndexOf('.'));
            if (value === undefined) return;    // nothing to do
            if (stateName === '') return;       // if only base id there is nothing to handle. only called via onStateChange. Sending is done via sendDisplay
            let color = Number(self.deviceGroups[baseId + '.color'].val);
            let inverted = self.deviceGroups[baseId + '.inverted'].val;
            let line1 = self.deviceGroups[baseId + '.line1'].val || '';
            let line1_ct = self.deviceGroups[baseId + '.line1_ct'].val;
            let line2 = self.deviceGroups[baseId + '.line2'].val || '';
            let line2_ct = self.deviceGroups[baseId + '.line2_ct'].val;

            switch (stateName) {                    // correction of malformed values
                case 'color':
                    color = Number(value);
                    if (color < 0 || color > 7) {
                        color = 0;
                        await self.setStateAsync(baseId + '.color', color, true);
                    }
                    self.deviceGroups[baseId + '.color'].val = color.toString();
                    break;

                case 'inverted':
                    inverted = Boolean(value);
                    self.deviceGroups[baseId + '.inverted'].val = inverted;
                    break;

                case 'line1':
                    line1 = value.toString();
                    if (!self.isASCII(line1)) {
                        line1 = '';
                        await self.setStateAsync(baseId + '.line1', line1, true);
                    }
                    if (line1.length > 7) {
                        line1 = line1.substr(0,7);
                        await self.setStateAsync(baseId + '.line1', line1, true);
                    }
                    self.deviceGroups[baseId + '.line1'].val = line1;
                    break;

                case 'line1_ct':
                    line1_ct = Boolean(value);
                    self.deviceGroups[baseId + '.line1_ct'].val = line1_ct;
                    break;

                case 'line2':
                    line2 = value.toString();
                    if (!self.isASCII(line2)) {
                        line2 = '';
                        await self.setStateAsync(baseId + '.line2', line2, true);
                    }
                    if (line1.length > 7) {
                        line1 = line1.substr(0,7);
                        await self.setStateAsync(baseId + '.line1', line1, true);
                    }
                    self.deviceGroups[baseId + '.line2'].val = line2;
                    break;

                case 'line2_ct':
                    line2_ct = Boolean(value);
                    self.deviceGroups[baseId + '.line2_ct'].val = line2_ct;
                    break;
            }

            self.sendDisplay(baseId);

            // ToDo: handle syncGlobal

        } catch (err) {
            self.errorHandler(err, 'handleDisplay');
        }
    }

    /**
     * handle the encoder status and call the send back if someting is changed
     * @param {string} encoderId                only when called via onStateChange
     * @param {any | null | undefined} value
     * @param {string} event                    pressed, released or value (value = when called via onStateChange)
     * @param {string} deviceAddress            only chen called via onServerMessage
     */
    async handleEncoder(encoderId, value = undefined, event = 'value', deviceAddress = '') {
        const self = this;
        try {
            let baseId;
            let stateName = '';         // the name of the particular state when called via onStateChange
            const encoderArr = encoderId.split('.');
            let activeBank = 0;
            let activeBaseChannel = 1;
            const deviceGroup = encoderArr[3];
            let actVal;
            let isDirty = false;        // if true the encoder states has changed and must be sent

            if (encoderId === '') {
                self.log.debug('X-Touch encoder not supported');
                return;
            }

            if (event === 'value') {    // when called via onStateChange there is the full encoder id, cut the last part for baseId
                baseId = encoderId.substr(0, encoderId.lastIndexOf('.'));
                stateName = encoderId.substr(encoderId.lastIndexOf('.') + 1);

                if (stateName === '') {
                    self.log.error('handleEncoder called with value and only baseId');
                    return;             // if no value part provided throw an error
                }
                switch (stateName) {

                    case 'cw':                                                                  // if wheel movement is simulated via database
                    case 'ccw':                                                                 // only on encoder wheel possible
                        self.timers.devicegroup[deviceGroup].refresh();                         // restart/refresh the timer
                        return;

                    case 'enabled':
                        if (self.deviceGroups[baseId + '.enabled'].val != Boolean(value)) {     // if changed send
                            self.deviceGroups[baseId + '.enabled'].val = Boolean(value);
                            isDirty = true;
                        }
                        break;

                    case 'mode':
                        if ((value < 0) || (value > 3) || !Number.isInteger(value)) value = 0;  // correct ?
                        if (self.deviceGroups[baseId + '.mode'].val != value) {                 // if changed send
                            self.deviceGroups[baseId + '.mode'].val = value;
                            isDirty = true;
                        }
                        break;

                    case 'pressed':                                                             // reset if sent via database
                        self.setState(baseId + '.pressed', false, true);
                        return;

                    case 'stepsPerTick':                                                        // check and correct
                        actVal = value;
                        if (value < 0) actVal = 0;
                        if (value > 1000) actVal = 1000;
                        if (!Number.isInteger(value)) actVal = parseInt(value, 10);
                        if (value != actVal) {                                                  // value corrected ?
                            await self.setStateAsync(baseId + '.stepsPerTick', Number(actVal), true);
                        }
                        if (self.deviceGroups[baseId + '.stepsPerTick'].val != actVal) {
                            self.deviceGroups[baseId + '.stepsPerTick'].val = actVal;
                            self.log.info(`handleEncoder changed the stepsPerTick to "${actVal}"`);
                        }
                        return;

                    case 'value':
                        if (value < 0) value = 0;
                        if (value > 1000) value = 1000;
                        if (!Number.isInteger(value)) value = parseInt(value, 10);
                        if (self.deviceGroups[baseId + '.value'].val != value) {
                            self.deviceGroups[baseId + '.value'].val = value;
                            await self.setStateAsync(baseId + '.value', Number(value), true);
                        }
                        break;
                }

            } else {                    // when called by midiMsg determine the real channel
                if ((deviceAddress !== '') && self.devices[deviceAddress]) {
                    activeBank = self.devices[deviceAddress].activeBank;
                    activeBaseChannel = self.devices[deviceAddress].activeBaseChannel;
                }
                if (encoderArr[4] === 'banks') {         // replace bank and baseChannel on channel encoders
                    encoderArr[5] = activeBank.toString();
                    encoderArr[7] = (Number(encoderArr[7]) + activeBaseChannel - 1).toString();
                }
                baseId = encoderArr.join('.');
            }

            if (encoderArr[5] === 'encoder') {          // only on encoder wheel
                switch (event) {
                    case 'cw':
                        await self.setStateAsync(baseId + '.cw', true, true);
                        self.timers.encoderWheels[deviceGroup].refresh();   // restart/refresh the timer
                        return;                                             // nothing more to do

                    case 'ccw':
                        await self.setStateAsync(baseId + '.ccw', true, true);
                        self.timers.encoderWheels[deviceGroup].refresh();   // restart/refresh the timer
                        return;                                             // nothing more to do

                    default:
                        self.log.error(`handleEncoder called with unknown event ${event} on encoder wheel`);
                }
            }

            if ((self.deviceGroups[baseId + '.enabled'].val !== true) && !isDirty) return;    // no farther processing if encoder disabled, only to send the status disabled on value "enabled" changed

            actVal = self.deviceGroups[baseId + '.value'].val;

            if (self.deviceGroups[baseId + '.value'].helperNum == -1) {         // first call
                self.deviceGroups[baseId + '.value'].helperNum = self.calculateEncoderValue(actVal);
            }

            switch (event) {
                case 'cw':              // rotate to increment value
                    actVal += (self.deviceGroups[baseId + '.stepsPerTick'].val * value);    // value contains the steps taken
                    if (actVal > 1000) actVal = 1000;
                    break;

                case 'ccw':             // rotate to decrement value
                    actVal -= (self.deviceGroups[baseId + '.stepsPerTick'].val * value);
                    if (actVal < 0) actVal = 0;
                    break;
            }

            self.deviceGroups[baseId + '.value'].val = actVal;
            await self.setStateAsync(baseId + '.value', actVal, true);

            if (self.deviceGroups[baseId + '.value'].helperNum != this.calculateEncoderValue(actVal)) {
                self.deviceGroups[baseId + '.value'].helperNum = this.calculateEncoderValue(actVal);
                // if display value changed send
                isDirty = true;
            }

            let logStr = `handleEncoder event: ${event} new value ${actVal} `;
            if (isDirty) {
                logStr += `going to send ${self.deviceGroups[baseId + '.value'].helperNum}`;
                self.sendEncoder(baseId);
            }
            self.log.debug(logStr);
            // ToDo: handle syncGlobal

        } catch (err) {
            self.errorHandler(err, 'handleEncoder');
        }
    }

    /**
     * handle the timecode display character status and call the send back if someting is changed
     * @param {string} charId                only when called via onStateChange
     * @param {any | null | undefined} value
     */
    async handleDisplayChar(charId, value = undefined) {
        const self = this;
        try {
            const characterArr = charId.split('.');
            const stateName = characterArr.length > 6 ? characterArr[6] : '';
            const baseId = charId.substr(0, charId.lastIndexOf('.'));
            if (value === undefined) return;    // nothing to do
            if (stateName === '') return;       // if only base id there is nothing to handle. only called via onStateChange. Sending is done via sendDisplayChar
            let char = self.deviceGroups[baseId + '.char'].val || '';
            let dot = self.deviceGroups[baseId + '.dot'].val || false;
            let enabled = self.deviceGroups[baseId + '.enabled'].val || false;
            let extended = self.deviceGroups[baseId + '.extended'].val;
            let mode = self.deviceGroups[baseId + '.mode'].val;

            switch (stateName) {                    // correction of malformed values
                case 'char':
                    char = value.toString();
                    if (!self.isASCII(char)) {
                        char = '';
                        await self.setStateAsync(baseId + '.char', char, true);
                    }
                    if (char.length > 1) {
                        char = char.substr(0,1);
                        await self.setStateAsync(baseId + '.char', char, true);
                    }
                    self.deviceGroups[baseId + '.char'].val = char;
                    break;

                case 'dot':
                    dot = Boolean(value);
                    self.deviceGroups[baseId + '.dot'].val = dot;
                    break;

                case 'enabled':
                    enabled = Boolean(value);
                    self.deviceGroups[baseId + '.enabled'].val = enabled;
                    break;

                case 'extended':
                    extended = Number(value);
                    if (extended < 0 || extended > 127) {
                        extended = 0;
                        await self.setStateAsync(baseId + '.extended', extended, true);
                    }
                    self.deviceGroups[baseId + '.extended'].val = extended.toString();
                    break;

                case 'mode':
                    mode = Number(value);
                    if ((mode < 0) || (mode > 1) || !Number.isInteger(mode)) {
                        mode = 0;
                        await self.setStateAsync(baseId + '.mode', mode, true);
                    }
                    self.deviceGroups[baseId + '.mode'].val = mode.toString();
                    break;
            }

            self.sendDisplayChar(baseId);

            // ToDo: handle syncGlobal

        } catch (err) {
            self.errorHandler(err, 'handleDisplayChar');
        }
    }

    /********************************************************************************
     * send functions to send back data to the device e.g. devices in the group
     ********************************************************************************
     *
     ********************************************************************************/
    /**
     * send back the button status, use same method to send the button state on restart and bank change
     * @param {string} buttonId
     * @param {string} deviceAddress    only chen called via deviceUpdatexx
     */
    async sendButton(buttonId, deviceAddress = '') {
        const self = this;
        try {
            self.log.silly('Now send back button state of button: "' + buttonId + '"');

            let selectedBank;
            let channelInBank;
            let isOnChannel = false;                // if button is on channel to check whether it is aktually seen
            const buttonArr = buttonId.split('.');
            const realChannel = buttonArr[7];
            if (buttonArr[4] === 'banks') {         // replace bank and baseChannel on channel buttons
                selectedBank = buttonArr[5];
                channelInBank = (Number(buttonArr[7]) % 8) == 0 ? '8' : (Number(buttonArr[7]) % 8).toString();
                // now "normalize" the array for lookup in the mapping
                buttonArr[5] = '0';
                buttonArr[7] = channelInBank;
                isOnChannel = true;
            }
            const actDeviceGroup = buttonArr[3];
            const newArr = [];
            for (let i = 4; i < buttonArr.length; i++) {
                newArr.push(buttonArr[i]);
            }
            let midiVal = 0;
            if (self.deviceGroups[buttonId + '.status'].val) {          // switch on
                if (self.deviceGroups[buttonId + '.flashing'].val) {
                    midiVal = 1;
                } else {
                    midiVal = 127;
                }
            }
            const midiNote = self.objects2Midi[newArr.join('.')];
            const midiCommand = new Uint8Array([0x90,  midiNote, midiVal]);

            for (const device of Object.keys(self.devices)) {
                if ((deviceAddress !== device) && (deviceAddress !== '')) continue;
                // if called via deviceUpdate only send to the selected device
                if (self.devices[device].connection == false) continue;     // skip offine devices
                if (isOnChannel) {
                    if ((actDeviceGroup == self.devices[device].memberOfGroup) &&
                        (selectedBank == self.devices[device].activeBank) &&
                        (Number(realChannel) >= self.devices[device].activeBaseChannel) &&
                        (Number(realChannel) < (self.devices[device].activeBaseChannel + 8))) {   // only if button seen on console
                        self.deviceSendData(midiCommand, self.devices[device].ipAddress, self.devices[device].port);
                    }
                }
                else {
                    if (actDeviceGroup == self.devices[device].memberOfGroup) {
                        self.deviceSendData(midiCommand, self.devices[device].ipAddress, self.devices[device].port);
                    }
                }
                // ToDo: handle syncGlobal
            }
        } catch (err) {
            self.errorHandler(err, 'sendButton');
        }
    }

    /**
     * send back the fader status, use same method to send the fader state on restart and bank change
     * @param {string} faderId
     * @param {string} deviceAddress    only chen called via onServerMessage, to avoid sendback of fadervalue to device where it came from
     * @param {boolean} fromHw          then fromHw = true. From deviceUpdatexx fromHw = false -> send the the address, otherwise skip
     */
    async sendFader(faderId, deviceAddress = '', fromHw = false) {
        const self = this;
        try {
            self.log.silly('Now send back state of fader: "' + faderId + '"');

            let selectedBank;
            let channelInBank;
            let isOnChannel = false;                // if fader is on channel to check whether it is aktually seen
            const faderArr = faderId.split('.');
            const realChannel = faderArr[7];
            if (faderArr[4] === 'banks') {          // replace bank and baseChannel on channel faders
                selectedBank = faderArr[5];
                channelInBank = (Number(faderArr[7]) % 8) == 0 ? '8' : (Number(faderArr[7]) % 8).toString();
                // now "normalize" the array for lookup in the mapping
                faderArr[5] = '0';
                faderArr[7] = channelInBank;
                isOnChannel = true;
            }
            const actDeviceGroup = faderArr[3];
            const logObj = self.calculateFaderValue(self.deviceGroups[faderId + '.value'].val, 'linValue');

            if (realChannel === undefined) channelInBank = 9;      // only if Master Fader
            const statusByte = 0xE0 + Number(channelInBank)-1;
            const dataByte2 = Math.floor(Number(logObj.midiValue) / 128).toFixed(0);
            const dataByte1 = Math.floor(Number(logObj.midiValue) - (Number(dataByte2) * 128)).toFixed(0);
            const midiCommand = new Uint8Array([statusByte, Number(dataByte1), Number(dataByte2)]);

            for (const device of Object.keys(self.devices)) {
                if (deviceAddress === device && fromHw) continue;
                if (deviceAddress !== device && !fromHw) continue;
                if (self.devices[device].connection == false) continue;     // skip offine devices
                if (isOnChannel) {
                    if ((actDeviceGroup == self.devices[device].memberOfGroup) &&
                        (selectedBank == self.devices[device].activeBank) &&
                        (Number(realChannel) >= self.devices[device].activeBaseChannel) &&
                        (Number(realChannel) < (self.devices[device].activeBaseChannel + 8))) {   // only if fader seen on console
                        //self.log.info(`send fader ${channelInBank} to ${device} value ${logObj.midiValue}`);
                        self.deviceSendData(midiCommand, self.devices[device].ipAddress, self.devices[device].port);
                    }
                }
                else {
                    if (actDeviceGroup == self.devices[device].memberOfGroup) {
                        //self.log.info(`send fader ${channelInBank} to ${device} value ${logObj.midiValue}`);
                        self.deviceSendData(midiCommand, self.devices[device].ipAddress, self.devices[device].port);
                    }
                }
                // ToDo: handle syncGlobal
            }
        } catch (err) {
            self.errorHandler(err, 'sendFader');
        }
    }

    /**
     * send back the display status
     * @param {string} displayId
     * @param {string} deviceAddress    only chen called via deviceUpdatexx
     */
    async sendDisplay(displayId, deviceAddress = '') {
        const self = this;
        try {
            let selectedBank;
            let channelInBank;
            let actDeviceGroup;
            const displayArr = displayId.split('.');
            const realChannel = displayArr[7];
            if (displayArr[4] === 'banks') {          // replace bank and baseChannel on channel buttons
                actDeviceGroup = displayArr[3];
                selectedBank = displayArr[5];
                channelInBank = (Number(displayArr[7]) % 8) == 0 ? '8' : (Number(displayArr[7]) % 8).toString();
            } else {
                self.log.error('sendDisplay called with a displayId with no banks identifier in it');
                return;
            }

            let baseId = displayId.substr(0, displayId.lastIndexOf('.'));
            const stateName = displayArr.length > 9 ? displayArr[9] : '';
            if (stateName === '') {
                baseId = displayId;                 // if called with no substate
            }
            const color = Number(self.deviceGroups[baseId + '.color'].val);
            const inverted = self.deviceGroups[baseId + '.inverted'].val;
            const line1 = self.deviceGroups[baseId + '.line1'].val || '';
            const line1_ct = self.deviceGroups[baseId + '.line1_ct'].val;
            const line2 = self.deviceGroups[baseId + '.line2'].val || '';
            const line2_ct = self.deviceGroups[baseId + '.line2_ct'].val;

            self.log.silly(`Now send back state of display: "${displayId}", Color: "${color}", Lines: "${line1}, ${line2}"`);

            let midiString = 'F000006658';
            midiString += ('20' + (32 + (Number(channelInBank) - 1)).toString(16)).slice(-2);       // Add channel 20 - 27
            if (inverted) {
                midiString += ('00' + (color + 64).toString(16)).slice(-2);
            } else {
                midiString += ('00' + color.toString(16)).slice(-2);
            }
            for (let strPos = 0; strPos < 7; strPos++) {
                if (strPos < line1.length) {
                    midiString += ('00' + String(line1).charCodeAt(strPos).toString(16).toUpperCase()).slice(-2);
                } else {
                    midiString += line1_ct ? '00' : '20';
                }
            }
            for (let strPos = 0; strPos < 7; strPos++) {
                if (strPos < line2.length) {
                    midiString += ('00' + String(line2).charCodeAt(strPos).toString(16).toUpperCase()).slice(-2);
                } else {
                    midiString += line2_ct ? '00' : '20';
                }
            }
            midiString += 'F7';

            const midiCommand = self.fromHexString(midiString);
            // F0 00 00 66 58 20 8 48 61 6c 6c 6f 20 20 64 75 00 00 00 00 00 F7
            // 240,0,0,102,88,32,8,72,97,108,108,111,32,32,100,117,0,0,0,0,0,247

            if (deviceAddress) {            // only send to this device (will only called with display which will be seen on this device)
                self.deviceSendData(midiCommand, deviceAddress, self.devices[deviceAddress].port);
            } else {                        // send to all connected devices on which this display is seen
                for (const device of Object.keys(self.devices)) {
                    if (self.devices[device].connection == false) continue;     // skip offine devices
                    if ((actDeviceGroup == self.devices[device].memberOfGroup) &&
                        (selectedBank == self.devices[device].activeBank) &&
                        (Number(realChannel) >= self.devices[device].activeBaseChannel) &&
                        (Number(realChannel) < (self.devices[device].activeBaseChannel + 8)) &&
                        (self.devices[device].connection)) {   // only if display seen on console and device connected
                        self.deviceSendData(midiCommand, self.devices[device].ipAddress, self.devices[device].port);
                    }
                }
            }

            // ToDo: handle syncGlobal

        } catch (err) {
            self.errorHandler(err, 'sendDisplay');
        }
    }

    /**
     * send back the encoder status
     * @param {string} encoderId
     * @param {string} deviceAddress    only chen called via deviceUpdatexx
     */
    async sendEncoder(encoderId, deviceAddress = '') {
        const self = this;
        try {
            let selectedBank;
            let channelInBank;
            let actDeviceGroup;
            const encoderArr = encoderId.split('.');
            const realChannel = encoderArr[7];
            if (encoderArr[4] === 'banks') {          // replace bank and baseChannel on channel buttons
                actDeviceGroup = encoderArr[3];
                selectedBank = encoderArr[5];
                channelInBank = (Number(encoderArr[7]) % 8) == 0 ? '8' : (Number(encoderArr[7]) % 8).toString();
            } else {
                self.log.error('sendEncoder called with a displayId with no banks identifier in it');
                return;
            }

            let baseId = encoderId.substr(0, encoderId.lastIndexOf('.'));
            const stateName = encoderArr.length > 9 ? encoderArr[9] : '';
            if (stateName === '') {
                baseId = encoderId;                 // if called with no substate
            }

            if (self.deviceGroups[baseId + '.value'].helperNum == -1) {         // first call
                self.deviceGroups[baseId + '.value'].helperNum = self.calculateEncoderValue(self.deviceGroups[baseId + '.value'].val);
            }

            const dispVal = self.deviceGroups[baseId + '.value'].helperNum;
            const ccByte1Left =  Number(channelInBank) + 47;      // controller 48 - 55
            const ccByte1Right = Number(channelInBank) + 55;      // controller 56 - 63
            let   ccByte2Left = self.encoderMapping['mode_' + self.deviceGroups[baseId + '.mode'].val][dispVal][0];
            let   ccByte2Right = self.encoderMapping['mode_' + self.deviceGroups[baseId + '.mode'].val][dispVal][1];

            if (self.deviceGroups[baseId + '.enabled'].val != true) {
                self.log.debug(`encoder "${baseId}" disabled. switch off`);
                ccByte2Left = 0;
                ccByte2Right = 0;
            }

            const midiCommand1 = new Uint8Array([0xB0,  ccByte1Left, ccByte2Left]);
            const midiCommand2 = new Uint8Array([0xB0,  ccByte1Right, ccByte2Right]);

            self.log.debug(`Now send back state of encoder: "${encoderId}", cc: "${ccByte1Left}:${ccByte1Right}", values: "${ccByte2Left}:${ccByte2Right}"`);

            if (deviceAddress) {            // only send to this device (will only called with display which will be seen on this device)
                self.deviceSendData(midiCommand1, deviceAddress, self.devices[deviceAddress].port);
                self.deviceSendData(midiCommand2, deviceAddress, self.devices[deviceAddress].port);
            } else {                        // send to all connected devices on which this display is seen
                for (const device of Object.keys(self.devices)) {
                    if (self.devices[device].connection == false) continue;     // skip offine devices
                    if ((actDeviceGroup == self.devices[device].memberOfGroup) &&
                        (selectedBank == self.devices[device].activeBank) &&
                        (Number(realChannel) >= self.devices[device].activeBaseChannel) &&
                        (Number(realChannel) < (self.devices[device].activeBaseChannel + 8)) &&
                        (self.devices[device].connection)) {
                        // only if display seen on console and device connected
                        self.deviceSendData(midiCommand1, self.devices[device].ipAddress, self.devices[device].port);
                        self.deviceSendData(midiCommand2, self.devices[device].ipAddress, self.devices[device].port);
                    }
                }
            }

            // ToDo: handle syncGlobal

        } catch (err) {
            self.errorHandler(err, 'sendEncoder');
        }
    }

    /**
     * send back the display character status
     * @param {string} charId
     * @param {string} deviceAddress    only chen called via deviceUpdatexx
     */
    async sendDisplayChar(charId, deviceAddress = '') {
        const self = this;
        try {
            const characterArr = charId.split('.');
            const actDeviceGroup = characterArr[3];
            const character = characterArr[5];
            const char = self.deviceGroups[charId + '.char'].val || '';
            const dot = self.deviceGroups[charId + '.dot'].val || false;
            const enabled = self.deviceGroups[charId + '.enabled'].val || false;
            const extended = self.deviceGroups[charId + '.extended'].val;
            const mode = self.deviceGroups[charId + '.mode'].val;
            let controller = 0;
            let charCode = 0;

            self.log.debug(`Now send back character: "${character}", Enabled: "${enabled}", Mode: "${mode}", Char: "${char}", Extended: "${extended}", HasDot: "${dot}"`);

            switch (character) {
                case 'assignment_left':
                    controller = 96;
                    break;

                case 'assignment_right':
                    controller = 97;
                    break;

                case 'hours_left':
                    controller = 98;
                    break;

                case 'hours_middle':
                    controller = 99;
                    break;

                case 'hours_right':
                    controller = 100;
                    break;

                case 'minutes_left':
                    controller = 101;
                    break;

                case 'minutes_right':
                    controller = 102;
                    break;

                case 'seconds_left':
                    controller = 103;
                    break;

                case 'seconds_right':
                    controller = 104;
                    break;

                case 'frames_left':
                    controller = 105;
                    break;

                case 'frames_middle':
                    controller = 106;
                    break;

                case 'frames_right':
                    controller = 107;
                    break;

            }

            if (mode == 0) {
                charCode = self.characterMapping[char] || 0;
            } else {
                charCode = extended || 0;
            }

            if (!enabled) {
                self.log.debug(`character "${charId}" disabled. switch off`);
                charCode = 0;
            } else {
                if (dot) controller += 16;      // the controller number with dot
                // only if enabled. When disabled send to controller without dot to switch of the dot
            }

            const midiCommand = new Uint8Array([0xB0,  controller, charCode]);

            if (deviceAddress) {            // only send to this device (will only called with display which will be seen on this device)
                self.deviceSendData(midiCommand, deviceAddress, self.devices[deviceAddress].port);
            } else {                        // send to all connected devices on which this display is seen
                for (const device of Object.keys(self.devices)) {
                    if (self.devices[device].connection == false) continue;     // skip offine devices
                    if ((actDeviceGroup == self.devices[device].memberOfGroup) &&
                        (self.devices[device].connection)) {
                        // only if display seen on console and device connected
                        self.deviceSendData(midiCommand, self.devices[device].ipAddress, self.devices[device].port);
                    }
                }
            }

            // ToDo: handle syncGlobal

        } catch (err) {
            self.errorHandler(err, 'sendDisplayChar');
        }
    }

    /**
     * switch the bank up and down
     * @param {string} action               bankUp, bankDown, channelUp, channelDown, none. action none used for illuminate the bank switches
     * @param {string} deviceAddress
     */
    async deviceSwitchChannels(action = 'none', deviceAddress = '') {
        const self = this;
        const activeGroup = self.devices[deviceAddress].memberOfGroup;
        const deviceIndex = self.devices[deviceAddress].index;
        let activeBank = self.devices[deviceAddress].activeBank;
        let activeBaseChannel = self.devices[deviceAddress].activeBaseChannel;
        let isDirty = false;

        try {
            switch (action) {
                case 'bankUp':
                    if ((activeBank + 1) < self.deviceGroups[self.namespace + '.deviceGroups.' + activeGroup + '.maxBanks'].val) {  // active bank is 0 based
                        activeBank++;
                        self.devices[deviceAddress].activeBank = activeBank;
                        await self.setStateAsync('devices.' + deviceIndex + '.activeBank', Number(activeBank), true);
                        // on bank change reset the baseChannel to 1
                        activeBaseChannel = 1;
                        self.devices[deviceAddress].activeBaseChannel = activeBaseChannel;
                        await self.setStateAsync('devices.' + deviceIndex + '.activeBaseChannel', Number(activeBaseChannel), true);
                        isDirty = true;
                    }
                    break;

                case 'bankDown':
                    if (activeBank > 0) {
                        activeBank--;
                        self.devices[deviceAddress].activeBank = activeBank;
                        await self.setStateAsync('devices.' + deviceIndex + '.activeBank', Number(activeBank), true);
                        // on bank change reset the baseChannel to 1
                        activeBaseChannel = 1;
                        self.devices[deviceAddress].activeBaseChannel = activeBaseChannel;
                        await self.setStateAsync('devices.' + deviceIndex + '.activeBaseChannel', Number(activeBaseChannel), true);
                        isDirty = true;
                    }
                    break;

                case 'channelUp':
                    if ((activeBaseChannel + 8) < self.deviceGroups[self.namespace + '.deviceGroups.' + activeGroup + '.banks.' + activeBank + '.maxChannels'].val) {
                        activeBaseChannel += 8;
                        self.devices[deviceAddress].activeBaseChannel = activeBaseChannel;
                        await self.setStateAsync('devices.' + deviceIndex + '.activeBaseChannel', Number(activeBaseChannel), true);
                        isDirty = true;
                    }
                    break;

                case 'channelDown':
                    if (activeBaseChannel > 8) {
                        activeBaseChannel -= 8;
                        self.devices[deviceAddress].activeBaseChannel = activeBaseChannel;
                        await self.setStateAsync('devices.' + deviceIndex + '.activeBaseChannel', Number(activeBaseChannel), true);
                        isDirty = true;
                    }
                    break;
            }

            if (isDirty || (action === 'none')) {       // only care of illumination if something changed or on action none

                let midiNote;
                let midiCommand;

                // illuminate bank switching
                if (self.deviceGroups[self.namespace + '.deviceGroups.' + activeGroup + '.illuminateBankSwitching'].val) {

                    // bankUp is possible ?
                    midiNote = self.objects2Midi['page.faderBankInc'];
                    if ((activeBank + 1) < self.deviceGroups[self.namespace + '.deviceGroups.' + activeGroup + '.maxBanks'].val) {
                        midiCommand = new Uint8Array([0x90,  midiNote, 127]);
                    } else {
                        midiCommand = new Uint8Array([0x90,  midiNote, 0]);
                    }
                    self.deviceSendData(midiCommand, self.devices[deviceAddress].ipAddress, self.devices[deviceAddress].port);

                    // bankDown is possible ?
                    midiNote = self.objects2Midi['page.faderBankDec'];
                    if (activeBank > 0) {
                        midiCommand = new Uint8Array([0x90,  midiNote, 127]);
                    } else {
                        midiCommand = new Uint8Array([0x90,  midiNote, 0]);
                    }
                    self.deviceSendData(midiCommand, self.devices[deviceAddress].ipAddress, self.devices[deviceAddress].port);
                }

                // illuminate channel switching
                if (self.deviceGroups[self.namespace + '.deviceGroups.' + activeGroup + '.illuminateChannelSwitching'].val) {

                    // channelUp is possible ?
                    midiNote = self.objects2Midi['page.channelInc'];
                    if ((activeBaseChannel + 8) < self.deviceGroups[self.namespace + '.deviceGroups.' + activeGroup + '.banks.' + activeBank + '.maxChannels'].val) {
                        midiCommand = new Uint8Array([0x90,  midiNote, 127]);
                    } else {
                        midiCommand = new Uint8Array([0x90,  midiNote, 0]);
                    }
                    self.deviceSendData(midiCommand, self.devices[deviceAddress].ipAddress, self.devices[deviceAddress].port);

                    // bankDown is possible ?
                    midiNote = self.objects2Midi['page.channelDec'];
                    if (activeBaseChannel > 8) {
                        midiCommand = new Uint8Array([0x90,  midiNote, 127]);
                    } else {
                        midiCommand = new Uint8Array([0x90,  midiNote, 0]);
                    }
                    self.deviceSendData(midiCommand, self.devices[deviceAddress].ipAddress, self.devices[deviceAddress].port);
                }
            }

            if (isDirty) self.deviceUpdateChannels(deviceAddress);

        } catch (err) {
            self.errorHandler(err, 'deviceSwitchBank');
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id                                   database id of the state which generates this event
     * @param {ioBroker.State | null | undefined} state     the state with value and acknowledge
     */
    async onStateChange(id, state) {
        const self = this;
        try {
            if (state) {
                // The state was changed
                //                self.log.debug(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
                if (!state.ack) {       // only react on not acknowledged state changes
                    if (state.lc === state.ts) {    // last changed and last updated equal then the value has changed
                        self.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
                        const baseId = id.substr(0, id.lastIndexOf('.'));
                        const locObj = await this.getObjectAsync(baseId);
                        if (typeof(locObj) !== 'undefined' && locObj !== null) {
                            const locRole = typeof(locObj.common.role) !== 'undefined' ? locObj.common.role : '';
                            switch (locRole) {
                                case 'button':
                                    self.handleButton(id, state.val, 'value');
                                    break;

                                case 'level.volume':
                                    self.handleFader(id, state.val, 'value');
                                    break;

                                case 'info.display':
                                    self.handleDisplay(id, state.val);
                                    break;

                                case 'encoder':
                                    self.handleEncoder(id, state.val);
                                    break;

                                case 'displayChar':
                                    self.handleDisplayChar(id, state.val);
                                    break;
                            }
                        }
                        if (/illuminate|max/.test(id)) {
                            self.log.warn(`X-Touch state ${id} changed. Please restart instance`);
                        }
                    }
                    else {
                        self.log.debug(`state ${id} only updated not changed: ${state.val} (ack = ${state.ack})`);
                    }
                }
            } else {
                // The state was deleted
                self.log.info(`state ${id} deleted`);
            }
        } catch (err) {
            self.errorHandler(err, 'onStateChange');
        }
    }

    /**
     * called for sending all elements on status update
     * @param {string} deviceAddress
     */
    async deviceUpdateDevice(deviceAddress) {
        const self = this;
        const activeGroup = self.devices[deviceAddress].memberOfGroup;
        try {
            // send all common buttons
            for (const actButton of self.consoleLayout.buttons) {
                const baseId = self.namespace + '.deviceGroups.' + activeGroup + '.' + actButton;
                self.sendButton(baseId, deviceAddress);
            }
            // send all display characters
            for (const actDisplayChar of self.consoleLayout.displayChars) {
                const baseId = self.namespace + '.deviceGroups.' + activeGroup + '.' + actDisplayChar;
                self.sendDisplayChar(baseId, deviceAddress);
            }
            // and the active fader bank
            self.deviceUpdateChannels(deviceAddress);
            // and now send the master fader
            self.sendFader(self.namespace + '.deviceGroups.' + activeGroup + '.masterFader', deviceAddress);
            // illuminate the page buttons
            self.deviceSwitchChannels('none', deviceAddress);

        } catch (err) {
            self.errorHandler(err, 'deviceUpdateDevice');
        }
    }

    /**
     * called for sending all active channel elements on status update
     * @param {string} deviceAddress
     */
    async deviceUpdateChannels(deviceAddress) {
        const self = this;
        const activeGroup = self.devices[deviceAddress].memberOfGroup;
        const activeBank = self.devices[deviceAddress].activeBank;
        const activeBaseChannel = self.devices[deviceAddress].activeBaseChannel;    // is 1, 9, ... for addition
        try {
            // send the active fader bank elements
            // loop through all visible channels
            for (let baseChannel = 1; baseChannel < 9; baseChannel++) {
                // and there for the elements
                for (const actElement of self.consoleLayout.channel) {
                    const baseId = self.namespace + '.deviceGroups.' + activeGroup + '.banks.' + activeBank + '.channels.' + (activeBaseChannel - 1 + baseChannel) + '.' + actElement;
                    switch (actElement) {
                        case 'encoder':
                            self.sendEncoder(baseId, deviceAddress);
                            break;

                        case 'display':
                            self.sendDisplay(baseId, deviceAddress);
                            break;

                        case 'fader':
                            self.sendFader(baseId, deviceAddress);
                            break;

                        default:
                            self.sendButton(baseId, deviceAddress);
                    }
                }
            }
        } catch (err) {
            self.errorHandler(err, 'deviceUpdateChannels');
        }
    }

    /**
     * called for sending data (adding to the queue)
     * @param {Buffer | Uint8Array | Array} data
     * @param {string} deviceAddress
     * @param {string | number} devicePort
     */
    deviceSendData(data, deviceAddress, devicePort = 10111) {
        const sendData = {
            'data': data,
            'address' : deviceAddress,
            'port': devicePort
        };
        // Add sendData to the buffer
        this.sendBuffer.push(sendData);

        if (!this.sendActive) {    // if sending is possible
            this.deviceSendNext(undefined, 'send');
        }
    }

    /**
     * send next data in the queue
     * @param {any} err
     * @param {string} event        event can be send=called from deviceSendData, hw=called from server.send, timer=called from the sendDelay timer
     */
    deviceSendNext(err = undefined, event = 'send') {
        const self = this;
        //self.log.info(`called with event: ${event}`);
        if (err) {
            self.errorHandler(err, 'deviceSendNext (server error)');
        } else {
            switch (event) {
                case 'hw':          // comming from server.send
                    //self.log.info('refreshing timer');
                    //self.timers.sendDelay.ref();
                    self.timers.sendDelay.refresh();
                    break;

                case 'timer':
                    //self.log.info('on timer');

                    if (self.sendBuffer.length > 0) {
                        self.sendActive = true;             // for now only push to sendqueue possible
                        const locLen = self.sendBuffer.length;
                        const locBuffer = self.sendBuffer.shift();
                        const logData = locBuffer.data.toString('hex').toUpperCase();
                        self.log.debug(`X-Touch send data (on timer): "${logData}" to device: "${locBuffer.address}" Send Buffer length: ${locLen}`);
                        self.server.send(locBuffer.data, locBuffer.port, locBuffer.address, self.deviceSendNext.bind(self, err, 'hw'));
                    } else {
                        self.log.silly('X-Touch send queue now empty (on timer)');
                        self.sendActive = false;            // queue is empty for now
                    }
                    break;

                case 'send':
                    //self.log.info('on send');

                    if (self.sendBuffer.length > 0) {
                        self.sendActive = true;             // for now only push to sendqueue possible
                        const locLen = self.sendBuffer.length;
                        const locBuffer = self.sendBuffer.shift();
                        const logData = locBuffer.data.toString('hex').toUpperCase();
                        self.log.debug(`X-Touch send data (on send): "${logData}" to device: "${locBuffer.address}" Send Buffer length: ${locLen}`);
                        self.server.send(locBuffer.data, locBuffer.port, locBuffer.address, self.deviceSendNext.bind(self, err, 'hw'));
                    } else {
                        self.log.silly('X-Touch send queue now empty (on send)');
                        self.sendActive = false;            // queue is empty for now
                    }
                    break;
            }
        }
    }

    /**
     * parse midi data, assume the data passed is complete (network transfer via udp)
     * @param {Buffer} midiData
     */
    parseMidiData(midiData) {
        const self = this;
        try {
            const midiMsg = {
                'msgType': '',      // NoteOff, NoteOn, AftertouchPoly, ControlChange, ProgramChange, AftertouchMono, Pitchbend, SysEx
                'channel': '',      // 0 - 15
                'note': '',         // Number of note in message
                'value': '',        // dynamic value, controller value, program change value, pitchvalue etc.
                'valueDB': '',      // if a pichbend is received, convert it in a range of -70.0 to 10.0 (fader value)
                'valueLin': '',     // if a pichbend is received, convert it in a range of 0 to 1000 (fader value)
                'controller': '',   // Controller number (for ControlChange)
                'programm': '',     // Programm number (for ProgramChange)
                'manufact': '',     // Mannufacturer ID on a SysEx Message
                'sysexMessage': ''  // the message part of a SysEx message ?!?
            };
            const statusByte = midiData[0];
            let byte1 = 0;
            let byte2 = 0;
            if (midiData.length > 1) byte1 = midiData[1];
            if (midiData.length > 2) byte2 = midiData[2];

            const msgType = statusByte & 0xF0;
            const msgChannel = statusByte & 0x0F;
            const locValue = (byte2 * 128) + byte1;
            const valObj = self.calculateFaderValue(locValue, 'midiValue');

            switch (msgType) {
                case 0x80:      // NoteOff
                    midiMsg.msgType = 'NoteOff';
                    midiMsg.channel = msgChannel.toString();
                    midiMsg.note = byte1.toString();
                    midiMsg.value = byte2.toString();
                    self.log.debug('X-Touch received a "NoteOff" event on channel: "' + midiMsg.channel + '" note: "' + midiMsg.note + '" value: "' + midiMsg.value + '"');
                    break;

                case 0x90:      // NoteOn
                    midiMsg.msgType = 'NoteOn';
                    midiMsg.channel = msgChannel.toString();
                    midiMsg.note = byte1.toString();
                    midiMsg.value = byte2.toString();
                    self.log.debug('X-Touch received a "NoteOn" event on channel: "' + midiMsg.channel + '" note: "' + midiMsg.note + '" value: "' + midiMsg.value + '"');
                    break;

                case 0xA0:      // AftertouchPoly
                    midiMsg.msgType = 'AftertouchPoly';
                    midiMsg.channel = msgChannel.toString();
                    midiMsg.note = byte1.toString();
                    midiMsg.value = byte2.toString();
                    self.log.debug('X-Touch received a "AftertouchPoly" event on channel: "' + midiMsg.channel + '" note: "' + midiMsg.note + '" value: "' + midiMsg.value + '"');
                    break;

                case 0xB0:      // ControlChange
                    midiMsg.msgType = 'ControlChange';
                    midiMsg.channel = msgChannel.toString();
                    midiMsg.controller = byte1.toString();
                    midiMsg.value = byte2.toString();
                    self.log.debug('X-Touch received a "ControlChange" event on channel: "' + midiMsg.channel + '" controller: "' + midiMsg.controller + '" value: "' + midiMsg.value + '"');
                    break;

                case 0xC0:      // ProgramChange
                    midiMsg.msgType = 'ProgramChange';
                    midiMsg.channel = msgChannel.toString();
                    midiMsg.programm = byte1.toString();
                    self.log.debug('X-Touch received a "ProgramChange" event on channel: "' + midiMsg.channel + '" programm: "' + midiMsg.programm + '"');
                    break;

                case 0xD0:      // AftertouchMono
                    midiMsg.msgType = 'AftertouchMono';
                    midiMsg.channel = msgChannel.toString();
                    midiMsg.value = byte1.toString();
                    self.log.debug('X-Touch received a "AftertouchMono" event on channel: "' + midiMsg.channel + '" value: "' + midiMsg.value + '"');
                    break;

                case 0xE0:      // Pitchbend
                    midiMsg.msgType = 'Pitchbend';
                    midiMsg.channel = msgChannel.toString();
                    midiMsg.valueDB = valObj.logValue;
                    midiMsg.valueLin = valObj.linValue;
                    midiMsg.value = locValue.toFixed(0);
                    this.log.debug('X-Touch received a "Pitchbend" event on channel: "' + midiMsg.channel + '" value: "' + midiMsg.valueLin + '" value in dB: "' + midiMsg.valueDB + '" orginal value:"' + locValue + '"');
                    break;

                case 0xF0:      // SysEx
                    midiMsg.msgType = 'SysEx';
                    midiMsg.sysexMessage = 'bla bla';
                    this.log.debug('X-Touch received a "SysEx" event');
                    break;

            }
            return midiMsg;

        } catch (err) {
            self.errorHandler(err, 'parseMidiData');
        }
        return {};
    }

    /**
     * create the database (populate all values an delete unused)
     */
    async createDatabaseAsync() {
        const self = this;

        self.log.debug('X-Touch start to create/update the database');

        // create the device groups
        for (let index = 0; index < self.config.deviceGroups; index++) {
            await self.createDeviceGroupAsync(index.toString());
        }

        // delete all unused device groups
        for(const key in await self.getAdapterObjectsAsync()){
            const tempArr = key.split('.');
            if (tempArr.length < 5) continue;
            if (tempArr[2] === 'devices') continue;
            if (Number(tempArr[3]) >= self.config.deviceGroups) {
                await self.delObjectAsync(key);
            }
        }

        // and now delete the unused device groups base folder
        for (let index = self.config.deviceGroups; index <= 4; index++) {
            await self.delObjectAsync(self.namespace + '.deviceGroups.' + index);
        }

        self.log.debug('X-Touch finished up database creation');
    }

    /**
     * create the given deviceGroup
     * @param {string} deviceGroup
     */
    async createDeviceGroupAsync(deviceGroup) {
        const self = this;
        try {
            await self.setObjectNotExistsAsync('deviceGroups.' + deviceGroup, self.objectsTemplate.deviceGroup);
            for (const element of self.objectsTemplate.deviceGroups) {
                await self.setObjectNotExistsAsync('deviceGroups.' + deviceGroup + '.' + element._id, element);

                if (element.common.role === 'button') {            // populate the button folder
                    for (const button of self.objectsTemplate.button) {
                        await self.setObjectNotExistsAsync('deviceGroups.' + deviceGroup + '.' + element._id + '.' + button._id, button);
                    }
                }
                if (element.common.role === 'level.volume') {      // populate the fader folder
                    for (const fader of self.objectsTemplate.levelVolume) {
                        await self.setObjectNotExistsAsync('deviceGroups.' + deviceGroup + '.' + element._id + '.' + fader._id, fader);
                    }
                }

                if (element.type === 'folder' && element._id !== 'banks') {      // populate the section, but not banks
                    await self.setObjectNotExistsAsync('deviceGroups.' + deviceGroup + '.' + element._id, element);

                    for (const sectElem of self.objectsTemplate[element._id]) {         // find the section
                        await self.setObjectNotExistsAsync('deviceGroups.' + deviceGroup + '.' + element._id + '.' + sectElem._id, sectElem);

                        if (sectElem.common.role === 'button') {            // populate the button folder
                            for (const button of self.objectsTemplate.button) {
                                await self.setObjectNotExistsAsync('deviceGroups.' + deviceGroup + '.' + element._id + '.' + sectElem._id + '.' + button._id, button);
                            }
                        }
                        if (sectElem.common.role === 'led') {               // populate the led folder
                            for (const button of self.objectsTemplate.led) {
                                await self.setObjectNotExistsAsync('deviceGroups.' + deviceGroup + '.' + element._id + '.' + sectElem._id + '.' + button._id, button);
                            }
                        }
                        if (sectElem.common.role === 'level.volume') {      // populate the fader folder
                            for (const fader of self.objectsTemplate.levelVolume) {
                                await self.setObjectNotExistsAsync('deviceGroups.' + deviceGroup + '.' + element._id + '.' + sectElem._id + '.' + fader._id, fader);
                            }
                        }
                        if (sectElem.common.role === 'value.volume') {      // populate the meter folder
                            for (const meter of self.objectsTemplate.valueVolume) {
                                await self.setObjectNotExistsAsync('deviceGroups.' + deviceGroup + '.' + element._id + '.' + sectElem._id + '.' + meter._id, meter);
                            }
                        }
                        if (sectElem.common.role === 'encoder') {           // populate the encoder folder
                            for (const meter of self.objectsTemplate.encoder) {
                                await self.setObjectNotExistsAsync('deviceGroups.' + deviceGroup + '.' + element._id + '.' + sectElem._id + '.' + meter._id, meter);
                            }
                        }
                        if (sectElem.common.role === 'displayChar') {       // populate the displayChar folder
                            for (const displayChar of self.objectsTemplate.displayChar) {
                                await self.setObjectNotExistsAsync('deviceGroups.' + deviceGroup + '.' + element._id + '.' + sectElem._id + '.' + displayChar._id, displayChar);
                            }
                        }
                    }
                }
            }

            self.log.info(`create bank of devicegroup ${deviceGroup}`);
            await self.createBanksAsync(deviceGroup);

        } catch (err) {
            self.errorHandler(err, 'createDeviceGroupAsync');
        }
    }

    /**
     * create a number of banks as defines by maxBanks in the given device group
     * @param {string} deviceGroup
     */
    async createBanksAsync(deviceGroup) {
        const self = this;
        try {
            const tempObj = await self.getStateAsync('deviceGroups.' + deviceGroup + '.maxBanks');
            let maxBanks = (tempObj && tempObj.val) ? Number(tempObj.val) : 1;

            // @ts-ignore
            if (maxBanks > self.config.maxBanks) {
                maxBanks = self.config.maxBanks;
                await self.setStateAsync('deviceGroups.' + deviceGroup + '.maxBanks', Number(maxBanks), true);
            }

            // @ts-ignore
            for (let index = 0; index < maxBanks; index++) {
                const activeBank = 'deviceGroups.' + deviceGroup + '.banks.' + index;

                await self.setObjectNotExistsAsync(activeBank, self.objectsTemplate.bank);

                for (const element of self.objectsTemplate.banks) {
                    await self.setObjectNotExistsAsync(activeBank + '.' + element._id, element);

                    if (element.common.role === 'button') {             // populate the button folder
                        for (const button of self.objectsTemplate.button) {
                            await self.setObjectNotExistsAsync(activeBank + '.' + element._id + '.' + button._id, button);
                        }
                    }
                    if (element.common.role === 'level.volume') {       // populate the fader folder
                        for (const fader of self.objectsTemplate.level_volume) {
                            await self.setObjectNotExistsAsync(activeBank + '.' + element._id + '.' + fader._id, fader);
                        }
                    }
                    if (element.common.role === 'value.volume') {       // populate the meter folder
                        for (const meter of self.objectsTemplate.value_volume) {
                            await self.setObjectNotExistsAsync(activeBank + '.' + element._id + '.' + meter._id, meter);
                        }
                    }
                }

                await self.createChannelsAsync(deviceGroup, index.toString());
            }

            // delete all unused banks
            for(const key in await self.getAdapterObjectsAsync()){
                const tempArr = key.split('.');
                if (tempArr.length < 6) continue;
                if ((tempArr[3] == deviceGroup) && (Number(tempArr[5]) >= maxBanks)) {
                    await self.delObjectAsync(key);
                }
            }

            // and now delete the unused bank base folder
            for (let index = maxBanks; index <= self.config.maxBanks; index++) {
                await self.delObjectAsync(self.namespace + '.deviceGroups.' + deviceGroup + '.banks.' + index);
            }

        } catch (err) {
            self.errorHandler(err, 'createBanksAsync');
        }
    }

    /**
     * create a number of channels (faders)
     * @param {string} deviceGroup
     * @param {string} bank
     */
    async createChannelsAsync(deviceGroup, bank) {
        const self = this;
        try {
            const tempObj = await self.getStateAsync('deviceGroups.' + deviceGroup + '.banks.' + bank + '.maxChannels');
            let maxChannels = (tempObj && tempObj.val) ? Number(tempObj.val) : 8;

            if (Number(maxChannels) % 8) {               // if not a multiple of 8
                maxChannels = 8;
                await self.setStateAsync('deviceGroups.' + deviceGroup + '.banks.' + bank + '.maxChannels', Number(maxChannels), true);
            }

            // @ts-ignore
            if (maxChannels > self.config.maxChannels) {
                maxChannels = self.config.maxChannels;
                await self.setStateAsync('deviceGroups.' + deviceGroup + '.banks.' + bank + '.maxChannels', Number(maxChannels), true);
            }

            // @ts-ignore
            for (let channel = 1; channel <= maxChannels; channel++) {
                const activeChannel = 'deviceGroups.' + deviceGroup + '.banks.' + bank + '.channels.' + channel;

                await self.setObjectNotExistsAsync(activeChannel, self.objectsTemplate.channel);

                for (const element of self.objectsTemplate.channels) {
                    await self.setObjectNotExistsAsync(activeChannel + '.' + element._id, element);

                    if (element.common.role === 'button') {             // populate the button folder
                        for (const button of self.objectsTemplate.button) {
                            await self.setObjectNotExistsAsync(activeChannel + '.' + element._id + '.' + button._id, button);
                        }
                    }
                    if (element.common.role === 'level.volume') {       // populate the fader folder
                        for (const fader of self.objectsTemplate.levelVolume) {
                            await self.setObjectNotExistsAsync(activeChannel + '.' + element._id + '.' + fader._id, fader);
                        }
                    }
                    if (element.common.role === 'value.volume') {       // populate the meter folder
                        for (const meter of self.objectsTemplate.valueVolume) {
                            await self.setObjectNotExistsAsync(activeChannel + '.' + element._id + '.' + meter._id, meter);
                        }
                    }
                    if (element.common.role === 'info.display') {       // populate the meter folder
                        for (const display of self.objectsTemplate.infoDisplay) {
                            await self.setObjectNotExistsAsync(activeChannel + '.' + element._id + '.' + display._id, display);
                        }
                    }
                    if (element.common.role === 'encoder') {            // populate the encoder folder
                        for (const display of self.objectsTemplate.channelEncoder) {
                            await self.setObjectNotExistsAsync(activeChannel + '.' + element._id + '.' + display._id, display);
                        }
                    }
                }
            }

            // delete all unused channels
            for(const key in await self.getAdapterObjectsAsync()){
                const tempArr = key.split('.');
                if (tempArr.length < 9) continue;
                if ((tempArr[3] == deviceGroup) && (tempArr[5] === bank) && (Number(tempArr[7]) > maxChannels)) {
                    await self.delObjectAsync(key);
                }
            }

            // and now delete the unused channel base folder
            for (let index = maxChannels + 1; index <= self.config.maxChannels; index++) {
                await self.delObjectAsync(self.namespace + '.deviceGroups.' + deviceGroup + '.banks.' + bank + '.channels.' + index);
            }

        } catch (err) {
            self.errorHandler(err, 'createChannelsAsync');
        }
    }

    /**
     * map the given hex string to a UInt8Array
     * @param {string} hexString
     */
    fromHexString(hexString) {
        // @ts-ignore
        return new Uint8Array(hexString.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    }

    /**
     * format the given hex string to a byte separated form
     * @param {string} locStr
     */
    logHexData(locStr) {
        let retStr = '';
        for (let i = 0; i < locStr.length; i += 2) {
            retStr += locStr.substr(i, 2) + ' ';
        }
        retStr = retStr.substr(0, retStr.length - 1);
        return retStr;
    }

    /**
     * check whether the given string is ASCII 7-bit only
     * @param {string} str
     */
    isASCII(str) {
        // eslint-disable-next-line no-control-regex
        return /^[\x00-\x7F]*$/.test(str);
    }

    /**
     * calculate midiValue -> linValue -> logValue and back
     * @param {number | string | undefined} value
     * @param {string} type                     Type of value provided
     * midiValue, linValue, logValue
     * returns: Object with all 3 value types
     */
    calculateFaderValue(value, type = 'midiValue') {

        if (typeof value === 'undefined') return {};
        if (typeof value === 'string') value = Number(value);

        const locObj = {};
        const self = this;

        try {

            switch (type) {

                case 'midiValue':
                    value = value > 16380 ? 16380 : value;
                    value = value < 0 ? 0 : value;

                    locObj.midiValue = value.toFixed(0);
                    locObj.linValue = ((value / 16380) * 1000).toFixed(0);

                    if (value < 4400) {
                        locObj.logValue = (((value - 8800) / 110) + 10).toFixed(1);
                    } else if (value < 8650) {
                        locObj.logValue = (((value - 12890) / 212.5) + 10).toFixed(1);
                    } else {
                        locObj.logValue = (((value - 16380) / 386.5) + 10).toFixed(1);
                    }
                    break;

                case 'linValue':
                    value = value > 1000 ? 1000 : value;
                    value = value < 0 ? 0 : value;

                    locObj.linValue = value.toFixed(0);
                    locObj.midiValue = ((value / 1000) * 16380).toFixed(0);

                    // eslint-disable-next-line no-case-declarations
                    const calVal = Number(locObj.midiValue);
                    if (calVal < 4400) {
                        locObj.logValue = (((calVal - 8800) / 110) + 10).toFixed(1);
                    } else if (calVal < 8650) {
                        locObj.logValue = (((calVal - 12890) / 212.5) + 10).toFixed(1);
                    } else {
                        locObj.logValue = (((calVal - 16380) / 386.5) + 10).toFixed(1);
                    }
                    break;

                case 'logValue':
                    value = value > 10.0 ? 10.0 : value;
                    value = value < -70.0 ? -70.0 : value;

                    locObj.logValue = value.toFixed(1);

                    value = value - 10;
                    if (value > -20) {
                        locObj.midiValue = ((value * 386.5) + 16380).toFixed(0);
                    } else if (value > -40) {
                        locObj.midiValue = ((value * 212.5) + 12900).toFixed(0);
                    } else {
                        locObj.midiValue = ((value * 110) + 8800).toFixed(0);
                    }

                    locObj.linValue = ((Number(locObj.midiValue) / 16380) * 1000).toFixed(0);
                    break;
            }
        } catch (err) {
            self.errorHandler(err, 'calculateFaderValue');
        }

        return locObj;
    }

    /**
     * calculate encoder display value 0 - 1000 to 0 - 12
     * @param {*} value
     */
    calculateEncoderValue(value) {
        return parseInt((value / 77).toString(), 10);
    }

    /**
     * Called for creating a new file for recording
     * @returns {string}
	 */
    createExportFile() {
        const self = this;
        try {
            const locDateObj = new Date();
            // current date
            // current month
            const locMonth = ('0' + (locDateObj.getMonth() + 1)).slice(-2);
            // current day
            const locDay = ('0' + locDateObj.getDate()).slice(-2);
            // current year
            const locYear = locDateObj.getFullYear();
            // current hours
            const locHours = ('0' + locDateObj.getHours()).slice(-2);
            // current minutes
            const locMinutes = ('0' + locDateObj.getMinutes()).slice(-2);
            // current seconds
            const locSeconds = ('0' + locDateObj.getSeconds()).slice(-2);
            // now create the filename
            return `${locYear}${locMonth}${locDay}_${locHours}${locMinutes}${locSeconds}_X-Touch_Export.json`;
            // file will be written using the iobroker writefile utility
        } catch (err) {
            self.errorHandler(err, 'createExportFile');
        }
        return '';
    }

    /**
     * Called on error situations and from catch blocks
	 * @param {any} err
	 * @param {string} module
	 */
    errorHandler(err, module = '') {
        this.log.error(`X-Touch error in method: [${module}] error: ${err.message}, stack: ${err.stack}`);
    }

    /**
     * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
     * Using this method requires 'common.messagebox' property to be set to true in io-package.json
     * @param {ioBroker.Message} obj
     */
    async onMessage(obj) {
        const self = this;
        try {
            if (typeof obj === 'object' && obj.command) {
                self.log.info('X-Touch message: ' + JSON.stringify(obj));
                if (obj.command === 'export') {
                    // export values of the actual instance
                    self.log.info('X-Touch exporting values');

                    const exportFile = self.createExportFile();
                    const device_states = await self.getStatesOfAsync('deviceGroups');
                    const exportDeviceStates = {};
                    let tempObj;
                    let deviceObj;
                    for (const device_state of device_states) {
                        deviceObj = device_state;
                        tempObj = await self.getStateAsync(device_state._id);
                        // @ts-ignore
                        deviceObj.val = (tempObj && tempObj.val !== undefined) ? tempObj.val : '';
                        exportDeviceStates[deviceObj._id] = deviceObj;
                    }
                    self.writeFileAsync('x-touch.0', exportFile, JSON.stringify(exportDeviceStates, null, 2));

                    // Send response in callback
                    if (obj.callback) self.sendTo(obj.from, obj.command, `values exported to: "${exportFile}"`, obj.callback);
                } else if (obj.command === 'import') {
                    // export values of the actual instance
                    self.log.info('X-Touch importing values');

                    let importFile = 'file' in Object(obj.message) ? Object(obj.message).file : '';
                    const importPath = 'path' in Object(obj.message) ? Object(obj.message).path : '';
                    const importDeviceGroup = 'devicegroup' in Object(obj.message) ? Object(obj.message).devicegroup : '';
                    const importFiles = [];
                    let importJson;
                    let importContent;

                    if (importPath !== '') {
                        // look in the filesystem
                        // try to read the given file. If not exists run to the error portion
                        importJson = JSON.parse(fs.readFileSync(importPath + '/' + importFile, 'utf8'));
                    } else {
                        // look in the adapters file section
                        const tempDir = await self.readDirAsync('x-touch.0', '/');
                        for (const file of tempDir) {
                            if (file.isDir) continue;       // skip directories
                            if (file.file === importFile) {
                                self.log.debug(`Importfile "${importFile}" found.`);
                                importFiles.push(importFile);   // for later existance in array
                                break;
                            }
                            const fileName = file.file;
                            if (fileName.split('.').pop() !== 'json') continue;
                            importFiles.push(fileName);
                        }
                        importFiles.sort();
                        if (importFile === '') importFile = importFiles[importFiles.length - 1];   // if none specified pop the last in array
                        if (!importFiles.includes(importFile)) throw({'message': `File "${importFile}" does not exist in directory`});
                        // try to read the file
                        importContent = await self.readFileAsync('x-touch.0', importFile);
                        // @ts-ignore
                        importJson = JSON.parse(importContent.data.toString());
                        self.log.debug(`File "${importFile}" red`);
                    }

                    for (const dbObject of Object.keys(importJson)) {        // iterate through the file elements
                        if (dbObject.substr(0, 22) !== 'x-touch.0.deviceGroups') continue;                           // skip foreign objects
                        if ((dbObject.substr(23, 1) !== importDeviceGroup) && importDeviceGroup !== '') continue;    // skip unselected devicegroups
                        if (await self.getStateAsync(dbObject)) {           // Object exists in db
                            if ((importJson[dbObject].val !== undefined) && (importJson[dbObject].common.write !== undefined) && (importJson[dbObject].common.write)) {
                                self.log.debug(`Setting object: "${dbObject}" with value: "${importJson[dbObject].val}"`);
                                await self.setStateAsync(dbObject, importJson[dbObject].val, false);                    // set as not acknowledged so it will be transmitted immediate to the X-Touch
                            }
                        }
                    }

                    // Send response in callback
                    if (obj.callback) self.sendTo(obj.from, obj.command, `values imported from file "${importFile}"`, obj.callback);
                } else {
                    // export values of the actual instance
                    self.log.warn(`X-Touch received unknown command "${obj.command}" with message "${JSON.stringify(obj.message)}"`);
                    // Send response in callback
                    if (obj.callback) self.sendTo(obj.from, obj.command, `unknown command : "${obj.command}" with message "${JSON.stringify(obj.message)}"`, obj.callback);
                }
            }
        } catch (err) {
            self.errorHandler(err, 'onMessage');
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            const self = this;
            // Reset the connection indicator
            self.setState('info.connection', false, true);

            // Here you must clear all timeouts or intervals that may still be active
            // and for all devices set not connected
            for (const element of Object.keys(self.devices)) {
                self.setState('devices.' + self.devices[element].index + '.connection', false, true);
                if (self.devices[element].timerDeviceInactivityTimeout) self.devices[element].timerDeviceInactivityTimeout.clearTimeout();
            }

            // close the server port
            this.server.close(callback);
        } catch (e) {
            callback();
        }
    }

}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */

    module.exports = (options) => new XTouch(options);
} else {
    // otherwise start the instance directly
    new XTouch();
}