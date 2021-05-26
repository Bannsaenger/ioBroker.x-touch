/**
 *
 *      iobroker x-touch Adapter
 *
 *      Copyright (c) 2020-2021, Bannsaenger <bannsaenger@gmx.de>
 *
 *      MIT License
 *
 */

/*
 * ToDo:
 *     - when maxBanks or maxChannels changes, delete when rebuildDatabase is set
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

// Load your modules here, e.g.:
const fs = require('fs');
const udp = require('dgram');
const { debug } = require('console');

const POLL_REC    = 'F0002032585400F7';
const POLL_REPLY  = 'F00000661400F7';

const HOST_CON_QUERY = 'F000006658013031353634303730344539F7';
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
        // this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));

        // read Objects template for object generation
        this.objectsTemplate = JSON.parse(fs.readFileSync(__dirname + '/lib/objects_templates.json', 'utf8'));
        // and Midi mapping
        this.midi2Objects = JSON.parse(fs.readFileSync(__dirname + '/lib/midi_mapping.json', 'utf8'));
        this.objects2Midi = {};

        // devices object, key is ip address. Values are connection and memberOfGroup
        this.devices = [];
        this.nextDevice = 0;        // next device index for db creation
        this.deviceGroups = [];

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
            create the database
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

            const device_states = await self.getStatesOfAsync('deviceGroups');
            for (const device_state of device_states) {
                self.deviceGroups[device_state._id] = device_state;
                tempObj = await self.getStateAsync(device_state._id);
                // @ts-ignore
                self.deviceGroups[device_state._id].val = tempObj ? tempObj.val : '';
                self.deviceGroups[device_state._id].helperBool = false;                     // used for e.g. autoToggle
            }

            self.log.info('X-Touch got ' + Object.keys(self.deviceGroups).length + ' states from the db');

            // In order to get state updates, you need to subscribe to them. The following line adds a subscription for our variable we have created above.
            // Or, if you really must, you can also watch all states. Don't do this if you don't need to. Otherwise this will cause a lot of unnecessary load on the system:
            self.subscribeStates('*');

            // try to open open configured server port
            self.log.info('Bind UDP socket to: "' + self.config.bind + ':' + self.config.port + '"');
            self.server.bind(self.config.port, self.config.bind);

            // Set the connection indicator after startup
            self.setState('info.connection', true, true);
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
                    self.setState(prefix + 'ipAddress', deviceAddress, true);
                    self.setState(prefix + 'port', port, true);
                    self.setState(prefix + 'memberOfGroup', 0, true);
                    self.setState(prefix + 'connection', true, true);
                    self.deviceUpdateAll(deviceAddress);
                    if (self.devices[deviceAddress].timerDeviceInactivityTimeout) {
                        self.devices[deviceAddress].timerDeviceInactivityTimeout.refresh();
                    } else {
                        self.devices[deviceAddress].timerDeviceInactivityTimeout = setTimeout(this.onDeviceInactivityTimeoutExceeded.bind(this, deviceAddress), this.config.deviceInactivityTimeout);
                    }
                } else {        // object in db must exist. Only set state if connection changed to true
                    if (!self.devices[deviceAddress].connection) {
                        self.devices[deviceAddress].connection = true;
                        self.devices[deviceAddress].port = port;
                        self.log.info('X-Touch device with IP <' + deviceAddress + '> now online.');
                        self.setState('devices.' + self.devices[deviceAddress].index + '.connection', true, true);
                        self.setState('devices.' + self.devices[deviceAddress].index + '.port', port, true);        // port can have changed
                        self.deviceUpdateAll(deviceAddress);
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
                self.setState('devices.' + self.devices[deviceAddress].index + '.connection', false, true);
                if (self.devices[deviceAddress].timerDeviceInactivityTimeout) {
                    clearTimeout(self.devices[deviceAddress].timerDeviceInactivityTimeout);
                    self.devices[deviceAddress].timerDeviceInactivityTimeout = undefined;
                }
            }
        } catch (err) {
            self.errorHandler(err, 'setConnection');
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
     * Is called on new datagram msg from server
     * @param {Buffer} msg
     * @param {Object} info
     */
    async onServerMessage(msg, info) {
        const self = this;
        try {
            const msg_hex = msg.toString('hex').toUpperCase();
            const memberOfGroup = self.devices[info.address] ? self.devices[info.address].memberOfGroup : '0';
            let midiMsg;

            // If a polling is received then answer the polling to hold the device online
            if (msg_hex === POLL_REC){
                self.log.silly('X-Touch received Polling, give an reply "' + self.logHexData(POLL_REPLY) + '"');

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
                        } else {
                            await self.handleButton(baseId , undefined, actPressed ? 'pressed' : 'released', info.addres);
                        }
                        break;

                    case 'Pitchbend':               // Pitchbend (Fader value)
                        baseId = self.namespace + '.deviceGroups.' + memberOfGroup;
                        if (Number(midiMsg.channel) > 7) {      // Master Fader
                            baseId +=  '.masterFader';
                        } else {
                            baseId +=  '.banks.0.channels.' + (Number(midiMsg.channel) + 1) + '.fader';
                        }
                        await self.handleFader(baseId , midiMsg.value, 'fader', info.address);
                        break;
                }
            }
        } catch (err) {
            self.errorHandler(err, 'onServerMessage');
        }
    }

    /**
     * handle the button events and call the sendback when someting is changed
     * @param {string} buttonId
     * @param {any | null | undefined} value
     * @param {string} event        pressed, released, fader or value (value = when called via onStateChange)
     * @param {string} address      only chen called via onServerMessage
     */
    async handleButton(buttonId, value = undefined, event = 'value', address = '') {
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
                if ((address !== '') && self.devices[address]) {
                    activeBank = self.devices[address].activeBank;
                    activeBaseChannel = self.devices[address].activeBaseChannel;
                }
                if (buttonArr[4] === 'banks') {         // replace bank and baseChannel on channel buttons
                    buttonArr[5] = activeBank.toString();
                    buttonArr[7] = (Number(buttonArr[7]) + activeBaseChannel - 1).toString();
                }
                baseId = buttonArr.join('.');
            }

            stateName = buttonArr.length > 9 ? buttonArr[9] : '';
            const actPressed = event === 'pressed' ? true : false;

            if (stateName === 'encoder') {                  // encoder is only pressed event
                self.setState(baseId + '.pressed', actPressed, true);
            } else {
                actStatus = self.deviceGroups[baseId + '.status'].val;
                let setValue = actStatus;

                if (event === 'value') {

                    setValue = Boolean(value);

                } else {        // handle the button auto mode

                    if (self.deviceGroups[baseId + '.pressed'].val !== actPressed) {      // if status changed
                        self.deviceGroups[baseId + '.pressed'].val = actPressed;
                        self.setState(baseId + '.pressed', actPressed, true);

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
                }

                if ((self.deviceGroups[baseId + '.status'].val !== setValue) &&
                    ((stateName === '') || (stateName === 'status') || (stateName === 'pressed'))){      // if status changed
                    self.deviceGroups[baseId + '.status'].val = setValue;
                    self.setState(baseId + '.status', setValue, true);
                    isDirty = true;
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
     * handle the button events and call the sendback when someting is changed
     * @param {string} faderId
     * @param {any | null | undefined} value
     * @param {string} event        pressed, released or value (value = when called via onStateChange)
     * @param {string} address      only chen called via onServerMessage
     */
    async handleFader(faderId, value = undefined, event = 'value', address = '') {
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

            if (event === 'value') {    // when called via onStateChange there is the full fader id, cut the last part for baseId
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
                        self.setState(baseId + '.value', Number(locObj.linValue), true);            // maybe correct the format
                        self.setState(baseId + '.value_db', Number(locObj.logValue), true);         // update log value too
                        break;

                    case 'value_db':
                        locObj = self.calculateFaderValue(value, 'logValue');
                        if (self.deviceGroups[baseId + '.value_db'].val != locObj.logValue) {
                            self.deviceGroups[baseId + '.value_db'].val = locObj.logValue;
                            self.deviceGroups[baseId + '.value'].val = locObj.linValue;
                            isDirty = true;
                        }
                        self.setState(baseId + '.value_db', Number(locObj.logValue), true);         // maybe correct the format
                        self.setState(baseId + '.value', Number(locObj.linValue), true);            // update lin value too
                        break;

                    default:
                        self.log.warn('X-Touch unknown fader value: "' + faderId + '"');
                        return;
                }
            } else {                    // when called by midiMsg determine the real channel
                if ((address !== '') && self.devices[address]) {
                    activeBank = self.devices[address].activeBank;
                    activeBaseChannel = self.devices[address].activeBaseChannel;
                }
                if (faderArr[4] === 'banks') {         // replace bank and baseChannel
                    faderArr[5] = activeBank.toString();
                    faderArr[7] = (Number(faderArr[7]) + activeBaseChannel - 1).toString();
                }
                baseId = faderArr.join('.');

                if (event === 'touched') {
                    if (!self.deviceGroups[baseId + '.touched'].val) {      // if status changed
                        self.deviceGroups[baseId + '.touched'].val = true;
                        self.setState(baseId + '.touched', true, true);
                    }
                } else if (event === 'released') {
                    if (self.deviceGroups[baseId + '.touched'].val) {       // if status changed
                        self.deviceGroups[baseId + '.touched'].val = false;
                        self.setState(baseId + '.touched', false, true);
                    }
                } else if (event === 'fader') {

                    if (self.deviceGroups[baseId + '.value'].val != locObj.linValue) {
                        self.deviceGroups[baseId + '.value'].val = locObj.linValue;
                        self.setState(baseId + '.value', Number(locObj.linValue), true);
                        isDirty = true;
                    }
                    if (self.deviceGroups[baseId + '.value_db'].val != locObj.logValue) {
                        self.deviceGroups[baseId + '.value_db'].val = locObj.logValue;
                        self.setState(baseId + '.value_db', Number(locObj.logValue), true);
                        isDirty = true;
                    }

                } else {
                    self.log.error('X-Touch handleFader received unknown event: "' + event + '"');
                }
            }

            if (isDirty) {
                self.sendFader(baseId, address, true);
            }
        } catch (err) {
            self.errorHandler(err, 'handleFader');
        }
    }

    /**
     * send back the button status, use same method to send the button state on restart and bank change
     * @param {string} buttonId
     * @param {string} address      only chen called via deviceUpdateAll
     */
    async sendButton(buttonId, address = '') {
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
                if ((address !== device) && (address !== '')) continue;
                if (isOnChannel) {
                    if ((actDeviceGroup == self.devices[device].memberOfGroup) &&
                        (selectedBank == self.devices[device].activeBank) &&
                        (Number(realChannel) >= self.devices[device].activeBaseChannel) &&
                        (Number(realChannel) <= (self.devices[device].activeBaseChannel + 8))) {   // only if button seen on console
                        self.deviceSendData(midiCommand, self.devices[device].ipAddress, self.devices[device].port);
                    }
                }
                else {
                    self.deviceSendData(midiCommand, self.devices[device].ipAddress, self.devices[device].port);
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
     * @param {string} address      only chen called via onServerMessage, to avoid sendback of fadervalue to device where it came from
     * @param {boolean} fromHw      then fromHw = true. From deviceUpdateAll fromHw = false -> send the the address, otherwise skip
     */
    async sendFader(faderId, address = '', fromHw = false) {
        const self = this;
        try {
            self.log.silly('Now send back state of fader: "' + faderId + '"');

            let selectedBank;
            let channelInBank;
            let isOnChannel = false;                // if fader is on channel to check whether it is aktually seen
            const faderArr = faderId.split('.');
            let realChannel = faderArr[7];
            if (faderArr[4] === 'banks') {          // replace bank and baseChannel on channel buttons
                selectedBank = faderArr[5];
                channelInBank = (Number(faderArr[7]) % 8) == 0 ? '8' : (Number(faderArr[7]) % 8).toString();
                // now "normalize" the array for lookup in the mapping
                faderArr[5] = '0';
                faderArr[7] = channelInBank;
                isOnChannel = true;
            }
            const actDeviceGroup = faderArr[3];
            const logObj = self.calculateFaderValue(self.deviceGroups[faderId + '.value'].val, 'linValue');

            if (typeof realChannel === 'undefined') realChannel = '9';      // only if Master Fader
            const statusByte = 0xE0 + Number(realChannel)-1;
            const dataByte2 = Math.floor(Number(logObj.midiValue) / 128).toFixed(0);
            const dataByte1 = Math.floor(Number(logObj.midiValue) - (Number(dataByte2) * 128)).toFixed(0);
            const midiCommand = new Uint8Array([statusByte, Number(dataByte1), Number(dataByte2)]);

            for (const device of Object.keys(self.devices)) {
                if (address === device && fromHw) continue;
                if (address !== device && !fromHw) continue;
                if (isOnChannel) {
                    if ((actDeviceGroup == self.devices[device].memberOfGroup) &&
                        (selectedBank == self.devices[device].activeBank) &&
                        (Number(realChannel) >= self.devices[device].activeBaseChannel) &&
                        (Number(realChannel) <= (self.devices[device].activeBaseChannel + 8))) {   // only if button seen on console
                        self.deviceSendData(midiCommand, self.devices[device].ipAddress, self.devices[device].port);
                    }
                }
                else {
                    self.deviceSendData(midiCommand, self.devices[device].ipAddress, self.devices[device].port);
                }
                // ToDo: handle syncGlobal
            }
        } catch (err) {
            self.errorHandler(err, 'sendFader');
        }
    }

    /**
     * send back the display status, used on restart and bank change, there is no handleDisplay, all in here
     * @param {string} displayId
     * @param {any | null | undefined} value
     * @param {string} address
     */
    async sendDisplay(displayId, value = undefined, address = '') {
        const self = this;
        try {
            self.log.silly('Now send back state of display: "' + displayId + '"');

            let selectedBank;
            let channelInBank;
            const displayArr = displayId.split('.');
            const realChannel = displayArr[7];
            if (displayArr[4] === 'banks') {          // replace bank and baseChannel on channel buttons
                selectedBank = displayArr[5];
                channelInBank = (Number(displayArr[7]) % 8) == 0 ? '8' : (Number(displayArr[7]) % 8).toString();
                // now "normalize" the array for lookup in the mapping
                displayArr[5] = '0';
                displayArr[7] = channelInBank;
            }
            const actDeviceGroup = displayArr[3];

            let baseId = displayId.substr(0, displayId.lastIndexOf('.'));
            const stateName = displayArr.length > 9 ? displayArr[9] : '';
            if (stateName === '') {
                baseId = displayId;                 // if called with no substate, from deviceUpdateAll
            }
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
                        self.setState(baseId + '.color', color, true);
                    }
                    self.deviceGroups[baseId + '.color'].val = color.toString();
                    break;

                case 'inverted':
                    inverted = Boolean(value);
                    self.deviceGroups[baseId + '.inverted'].val = color.toString();
                    break;

                case 'line1':
                    line1 = value.toString();
                    if (!self.isASCII(line1)) {
                        line1 = '';
                        self.setState(baseId + '.line1', line1, true);
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
                        self.setState(baseId + '.line2', line2, true);
                    }
                    self.deviceGroups[baseId + '.line2'].val = line2;
                    break;

                case 'line2_ct':
                    line2_ct = Boolean(value);
                    self.deviceGroups[baseId + '.line2_ct'].val = line2_ct;
                    break;
            }


            let midiString = 'F000006658';
            midiString += ('20' + (32 + (Number(channelInBank) - 1)).toString(16)).slice(-2);       // Add channel 20 -27
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
            for (const device of Object.keys(self.devices)) {
                if ((address !== device) && (address !== '')) continue;
                if ((actDeviceGroup == self.devices[device].memberOfGroup) &&
                    (selectedBank == self.devices[device].activeBank) &&
                    (Number(realChannel) >= self.devices[device].activeBaseChannel) &&
                    (Number(realChannel) <= (self.devices[device].activeBaseChannel + 8))) {   // only if button seen on console
                    self.deviceSendData(midiCommand, self.devices[device].ipAddress, self.devices[device].port);
                }
                else {
                    self.deviceSendData(midiCommand, self.devices[device].ipAddress, self.devices[device].port);
                }
                // ToDo: handle syncGlobal
            }
        } catch (err) {
            self.errorHandler(err, 'sendDisplay');
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    async onStateChange(id, state) {
        const self = this;
        try {
            if (state) {
                // The state was changed
                //                self.log.debug(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
                if (!state.ack) {       // only react on not acknowledged state changes
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
                                self.sendDisplay(id, state.val);
                                break;
                        }
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
            this.deviceSendNext();
        }
    }

    /**
     * called for sending all elements on status update
     * @param {string} deviceAddress
     */
    async deviceUpdateAll(deviceAddress) {
        const self = this;
        try {
            let lastId = '';
            for (const actObj of Object.keys(self.deviceGroups)) {
                const baseId = actObj.substr(0, actObj.lastIndexOf('.'));
                if (baseId !== lastId) {
                    const locObj = await this.getObjectAsync(baseId);
                    if (typeof(locObj) !== 'undefined' && locObj !== null) {
                        const locRole = typeof(locObj.common.role) !== 'undefined' ? locObj.common.role : '';
                        switch (locRole) {
                            case 'button':
                                self.sendButton(baseId, deviceAddress);
                                break;

                            case 'level.volume':
                                self.sendFader(baseId, deviceAddress);
                                break;

                            case 'info.display':
                                self.sendDisplay(baseId, undefined, deviceAddress);
                                break;
                        }
                    }
                }
                lastId = baseId;
            }
        } catch (err) {
            self.errorHandler(err, 'deviceUpdateAll');
        }
    }

    /**
     * called for sending all elements on status update
     * @param {string} deviceAddress
     */
    deviceUpdateBank(deviceAddress) {
        // only for error avoidance
        this.log.info(deviceAddress);
    }

    /**
     * called for sending all elements on status update
     * @param {string} deviceAddress
     */
    deviceUpdateChannels(deviceAddress) {
        // only for error avoidance
        this.log.info(deviceAddress);
    }

    /**
     * send next data in the queue
     * @param {any} err
     */
    deviceSendNext(err = undefined) {
        const self = this;
        if (err) {
            self.log.error('X-Touch received an error on sending data');
        } else {
            if (self.sendBuffer.length > 0) {
                const localBuffer = self.sendBuffer.shift();
                const logData = localBuffer.data.toString('hex').toUpperCase();
                self.log.debug('X-Touch send data: "' + logData + '" to device: "' + localBuffer.address + '"');
                self.server.send(localBuffer.data, localBuffer.port, localBuffer.address, self.deviceSendNext.bind(self, err));
            } else {
                self.log.silly('X-Touch send queue now empty');
                self.sendActive = false;            // queue is empty for now
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
                'valueDB': '',      // when a pichbend is received, convert it in a range of -70.0 to 10.0 (fader value)
                'valueLin': '',     // when a pichbend is received, convert it in a range of 0 to 1000 (fader value)
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

        self.log.debug('Extron start to create/update the database');
        /*
        create the device groups
        */
        for (let index = 0; index < self.config.deviceGroups; index++) {
            await self.createDeviceGroupAsync(index.toString());
        }

        for(const key in await self.getAdapterObjectsAsync()){
            const tempArr = key.split('.');
            if (tempArr.length < 5) continue;
            if (Number(tempArr[3]) >= self.config.deviceGroups) {
                await self.delObjectAsync(key);
            }
        }

        self.log.debug('Extron finished up database creation');
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
                    }
                }
            }

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
            const maxBanks = await self.getStateAsync('deviceGroups.' + deviceGroup + '.maxBanks');
            const maxBanksNum = maxBanks ? maxBanks.val : 1;

            // @ts-ignore
            for (let index = 0; index < maxBanksNum; index++) {
                const activeBank = 'deviceGroups.' + deviceGroup + '.banks.' + index;

                await self.setObjectNotExistsAsync(activeBank, self.objectsTemplate.bank);

                for (const element of self.objectsTemplate.banks) {
                    await self.setObjectNotExistsAsync(activeBank + '.' + element._id, element);

                    if (element.common.role === 'button') {     // populate the button folder
                        for (const button of self.objectsTemplate.button) {
                            await self.setObjectNotExistsAsync(activeBank + '.' + element._id + '.' + button._id, button);
                        }
                    }
                    if (element.common.role === 'level.volume') {     // populate the fader folder
                        for (const fader of self.objectsTemplate.level_volume) {
                            await self.setObjectNotExistsAsync(activeBank + '.' + element._id + '.' + fader._id, fader);
                        }
                    }
                    if (element.common.role === 'value.volume') {     // populate the meter folder
                        for (const meter of self.objectsTemplate.value_volume) {
                            await self.setObjectNotExistsAsync(activeBank + '.' + element._id + '.' + meter._id, meter);
                        }
                    }
                }

                await self.createChannelsAsync(deviceGroup, index.toString());
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
            const maxChannels = await self.getStateAsync('deviceGroups.' + deviceGroup + '.banks.' + bank + '.maxChannels');
            const maxChannelsNum = maxChannels ? maxChannels.val : 8;

            // @ts-ignore
            for (let channel = 1; channel <= maxChannelsNum; channel++) {
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
        let self = this;

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
     * Called on error situations and from catch blocks
	 * @param {Error} err
	 * @param {string} module
	 */
    errorHandler(err, module = '') {

        this.log.error(`Extron error in method: [${module}] error: ${err.message}, stack: ${err.stack}`);
    }

    // If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
    // /**
    //  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
    //  * Using this method requires 'common.message' property to be set to true in io-package.json
    //  * @param {ioBroker.Message} obj
    //  */
    // onMessage(obj) {
    //     if (typeof obj === 'object' && obj.message) {
    //         if (obj.command === 'send') {
    //             // e.g. send email or pushover or whatever
    //             this.log.info('send command');

    //             // Send response in callback if required
    //             if (obj.callback) this.sendTo(obj.from, obj.command, 'Message received', obj.callback);
    //         }
    //     }
    // }

}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */

    module.exports = (options) => {'use strict'; new XTouch(options); };
} else {
    // otherwise start the instance directly
    new XTouch();
}