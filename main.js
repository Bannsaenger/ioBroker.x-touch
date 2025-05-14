/**
 *
 *      iobroker x-touch Adapter
 *
 *      Copyright (c) 2020-2025, Bannsaenger <bannsaenger@gmx.de>
 *
 *      MIT License
 *
 */

/*
 * ToDo:
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

// Load your modules here, e.g.:
const fs = require('fs');
const udp = require('dgram');

// const { debug } = require('console');

const POLL_REC = 'F0002032585400F7';
const POLL_REPLY = 'F00000661400F7';

//const HOST_CON_QUERY = 'F000006658013031353634303730344539F7';
const HOST_CON_QUERY = 'F000006658013031353634303732393345F7';
const HOST_CON_REPLY = 'F0000066580230313536343037353D1852F7';

class XTouch extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] Options from js-controller
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
        this.objectTemplates = JSON.parse(fs.readFileSync(`${__dirname}/lib/object_templates.json`, 'utf8'));
        // Midi mapping
        this.midi2Objects = JSON.parse(fs.readFileSync(`${__dirname}/lib/midi_mapping.json`, 'utf8'));
        this.objects2Midi = {};
        // and layout
        this.consoleLayout = JSON.parse(fs.readFileSync(`${__dirname}/lib/console_layout.json`, 'utf8'));
        // mapping of the encoder modes to LED values
        this.encoderMapping = JSON.parse(fs.readFileSync(`${__dirname}/lib/encoder_mapping.json`, 'utf8'));
        // mapping of the characters in timecode display to 7-segment
        // coding is in Siekoo-Alphabet (https://fakoo.de/siekoo.html)
        // not as described in Logic Control Manual
        this.characterMapping = JSON.parse(fs.readFileSync(`${__dirname}/lib/character_mapping.json`, 'utf8'));

        // devices object, key is ip address. Values are connection and memberOfGroup
        this.devices = [];
        this.nextDevice = 0; // next device index for db creation
        this.deviceGroups = [];
        this.timers = {}; // a place to store timers
        this.timers.encoderWheels = {}; // e.g. encoder wheel reset timers by device group
        this.timers.sendDelay = undefined; // put the timer based on the configured sendDelay here

        // Send buffer (Array of sendData objects)
        // sendData = {
        //      data: {buffer | array of buffers}
        //      address : {string}          // ipAddress
        //      port: {string | number}     // port to send back (normally 10111)
        // }
        this.sendBuffer = [];
        this.sendActive = false; // true if data sending is ongoing right now

        // creating a udp server
        this.server = udp.createSocket('udp4');
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        try {
            // Initialize your adapter here
            // Reset the connection indicator during startup
            this.setState('info.connection', false, true);

            // emits when any error occurs
            this.server.on('error', this.onServerError.bind(this));

            // emits when socket is ready and listening for datagram msgs
            this.server.on('listening', this.onServerListening.bind(this));

            // emits after the socket is closed using socket.close();
            this.server.on('close', this.onServerClose.bind(this));

            // emits on new datagram msg
            this.server.on('message', this.onServerMessage.bind(this));

            // The adapters config (in the instance object everything under the attribute 'native' is accessible via
            // this.config:

            /*
             * create a vice versa mapping in object2Midi
             */
            for (const mapping of Object.keys(this.midi2Objects)) {
                this.objects2Midi[this.midi2Objects[mapping]] = mapping;
            }
            /*
             * For every state in the system there has to be also an object of type state
             */
            for (const element of this.objectTemplates.common) {
                await this.setObjectNotExistsAsync(element._id, element);
            }

            /*
             * create the database
             */
            await this.createDatabaseAsync();

            // Read all devices in the db
            let tempObj;
            let actDeviceNum = '-1';
            const result_state = await this.getStatesOfAsync('devices');

            for (const element of result_state) {
                const splitStringArr = element._id.split('.');

                if (splitStringArr[3] !== actDeviceNum) {
                    // next device detected
                    actDeviceNum = splitStringArr[3];
                    tempObj = await this.getStateAsync(`devices.${actDeviceNum}.deviceLocked`);
                    const actDeviceLocked = tempObj && tempObj.val ? tempObj.val.toString() : '';
                    tempObj = await this.getStateAsync(`devices.${actDeviceNum}.ipAddress`);
                    const actIpAddress = tempObj && tempObj.val ? tempObj.val.toString() : '';
                    tempObj = await this.getStateAsync(`devices.${actDeviceNum}.port`);
                    const actPort = tempObj && tempObj.val ? tempObj.val.toString() : '';
                    tempObj = await this.getStateAsync(`devices.${actDeviceNum}.memberOfGroup`);
                    const actMemberOfGroup = tempObj && tempObj.val ? tempObj.val : 0;
                    tempObj = await this.getStateAsync(`devices.${actDeviceNum}.serialNumber`);
                    const actSerialNumber = tempObj && tempObj.val ? tempObj.val.toString() : '';
                    tempObj = await this.getStateAsync(`devices.${actDeviceNum}.activeBank`);
                    const actActiveBank = tempObj && tempObj.val ? tempObj.val : 0;
                    tempObj = await this.getStateAsync(`devices.${actDeviceNum}.activeBaseChannel`);
                    const actActiveBaseChannel = tempObj && tempObj.val ? tempObj.val : 0;

                    this.devices[actIpAddress] = {
                        index: actDeviceNum,
                        connection: false, // connection must be false on system start
                        deviceLocked: actDeviceLocked,
                        ipAddress: actIpAddress,
                        port: actPort,
                        memberOfGroup: actMemberOfGroup,
                        serialNumber: actSerialNumber,
                        activeBank: actActiveBank,
                        activeBaseChannel: actActiveBaseChannel,
                    };

                    this.log.debug(
                        `X-Touch got device with ip address ${this.devices[actIpAddress].ipAddress} from the db`,
                    );
                }
            }

            this.nextDevice = Number(actDeviceNum) + 1;
            this.log.info(
                `X-Touch got ${Object.keys(this.devices).length} devices from the db. Next free device number: "${
                    this.nextDevice
                }"`,
            );

            // read all states from the device groups to memory
            const device_states = await this.getStatesOfAsync('deviceGroups');
            for (const device_state of device_states) {
                this.deviceGroups[device_state._id] = device_state;
                tempObj = await this.getStateAsync(device_state._id);
                this.deviceGroups[device_state._id].val = tempObj && tempObj.val !== undefined ? tempObj.val : '';
                this.deviceGroups[device_state._id].helperBool = false; // used for e.g. autoToggle
                this.deviceGroups[device_state._id].helperNum = -1; // used for e.g. display of encoders
            }

            this.log.info(`X-Touch got ${Object.keys(this.deviceGroups).length} states from the db`);

            // In order to get state updates, you need to subscribe to them. The following line adds a subscription for our variable we have created above.
            // Or, if you really must, you can also watch all states. Don't do this if you don't need to. Otherwise this will cause a lot of unnecessary load on the system:
            this.subscribeStates('*');

            // try to open open configured server port
            this.log.info(`Bind UDP socket to: "${this.config.bind}:${this.config.port}"`);
            this.server.bind(this.config.port, this.config.bind);

            // Set the connection indicator after startup
            // this.setState('info.connection', true, true);
            // set by onServerListening

            // create a timer to reset the encoder state for each device group
            for (let index = 0; index < this.config.deviceGroups; index++) {
                this.timers.encoderWheels[index] = setTimeout(
                    this.onEncoderWheelTimeoutExceeded.bind(this, index.toString()),
                    1000,
                );
            }
            // last action is to create the timer for the sendDelay and unref it immediately
            this.timers.sendDelay = setTimeout(
                this.deviceSendNext.bind(this, undefined, 'timer'),
                this.config.sendDelay || 1,
            );
            //this.timers.sendDelay.unref();
        } catch (err) {
            this.errorHandler(err, 'onReady');
        }
    }

    /**
     * Is called to set the connection state in db and log
     *
     * @param {string} deviceAddress    IP address of the device to handle
     * @param {number} port             Source port of device
     * @param {boolean} status          Status to set, online = true, offline = false
     */
    async setConnection(deviceAddress, port, status) {
        try {
            if (status) {
                /*
                create new device if this is the first polling since start of adapter
                */
                if (!(deviceAddress in this.devices)) {
                    this.devices[deviceAddress] = {
                        activeBank: 0,
                        activeBaseChannel: 1,
                        connection: true,
                        ipAddress: deviceAddress,
                        port: port,
                        memberOfGroup: 0,
                        serialNumber: '',
                        deviceLocked: false,
                        index: this.nextDevice,
                    };
                    let prefix = `devices.${this.nextDevice.toString()}`;
                    this.setObjectNotExists(prefix, this.objectTemplates.device);
                    prefix += '.';
                    this.nextDevice++;
                    for (const element of this.objectTemplates.devices) {
                        await this.setObjectNotExistsAsync(prefix + element._id, element);
                    }
                    this.log.info(`X-Touch device with IP <${deviceAddress}> created. Is now online.`);
                    this.setState(`${prefix}ipAddress`, deviceAddress, true);
                    this.setState(`${prefix}port`, port, true);
                    this.setState(`${prefix}memberOfGroup`, 0, true);
                    this.setState(`${prefix}connection`, true, true);
                    this.setState(`${prefix}deviceLocked`, false, true);
                    this.deviceUpdateDevice(deviceAddress);
                    if (this.devices[deviceAddress].timerDeviceInactivityTimeout) {
                        this.devices[deviceAddress].timerDeviceInactivityTimeout.refresh();
                    } else {
                        this.devices[deviceAddress].timerDeviceInactivityTimeout = setTimeout(
                            this.onDeviceInactivityTimeoutExceeded.bind(this, deviceAddress),
                            this.config.deviceInactivityTimeout,
                        );
                    }
                } else {
                    // object in db must exist. Only set state if connection changed to true
                    // create all not existing objects if device was created before
                    const prefix = `devices.${this.devices[deviceAddress].index}.`;
                    for (const element of this.objectTemplates.devices) {
                        await this.setObjectNotExistsAsync(prefix + element._id, element);
                    }
                    if (!this.devices[deviceAddress].connection) {
                        this.devices[deviceAddress].connection = true;
                        this.devices[deviceAddress].port = port;
                        this.log.info(`X-Touch device with IP <${deviceAddress}> is now online.`);
                        this.setState(`devices.${this.devices[deviceAddress].index}.connection`, true, true);
                        this.setState(`devices.${this.devices[deviceAddress].index}.port`, port, true); // port can have changed
                        this.deviceUpdateDevice(deviceAddress);
                    }
                    if (this.devices[deviceAddress].timerDeviceInactivityTimeout) {
                        this.devices[deviceAddress].timerDeviceInactivityTimeout.refresh();
                    } else {
                        this.devices[deviceAddress].timerDeviceInactivityTimeout = setTimeout(
                            this.onDeviceInactivityTimeoutExceeded.bind(this, deviceAddress),
                            this.config.deviceInactivityTimeout,
                        );
                    }
                }
            } else {
                this.devices[deviceAddress].connection = false;
                this.log.info(`X-Touch device with IP <${deviceAddress}> now offline.`);
                this.setState(`devices.${this.devices[deviceAddress].index}.connection`, false, true);
                if (this.devices[deviceAddress].timerDeviceInactivityTimeout) {
                    clearTimeout(this.devices[deviceAddress].timerDeviceInactivityTimeout);
                    this.devices[deviceAddress].timerDeviceInactivityTimeout = undefined;
                }
            }
        } catch (err) {
            this.errorHandler(err, 'setConnection');
        }
    }

    // Methods related to Server events
    /**
     * Is called if a server error occurs
     *
     * @param {any} error detected server error
     */
    onServerError(error) {
        this.log.error(`Server got Error: <${error}> closing server.`);
        // Reset the connection indicator
        this.setState('info.connection', false, true);
        this.server.close();
    }

    /**
     * Is called when the server is ready to process traffic
     */
    onServerListening() {
        const addr = this.server.address();
        this.log.info(`X-Touch server ready on <${addr.address}> port <${addr.port}> proto <${addr.family}>`);

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
     *
     * @param {string} deviceAddress IP address of the device to handle
     */
    onDeviceInactivityTimeoutExceeded(deviceAddress) {
        this.log.debug(`X-Touch device "${deviceAddress}" reached inactivity timeout`);
        this.setConnection(deviceAddress, 0, false);
    }

    /**
     * Is called when the encoder wheel values must be resetted to false
     *
     * @param {string} deviceGroup the device group to handle
     */
    onEncoderWheelTimeoutExceeded(deviceGroup) {
        this.log.debug(`X-Touch encoder wheel from device group ${deviceGroup}" reached inactivity timeout`);
        this.setState(`deviceGroups.${deviceGroup}.transport.encoder.cw`, false, true); // reset the
        this.setState(`deviceGroups.${deviceGroup}.transport.encoder.ccw`, false, true); // state values
    }

    /**
     * Is called on new datagram msg from server
     *
     * @param {Buffer} msg      the message content received by the server socket
     * @param {object} info     the info for e.g. address of sending host
     */
    async onServerMessage(msg, info) {
        try {
            const msg_hex = msg.toString('hex').toUpperCase();
            const memberOfGroup = this.devices[info.address] ? this.devices[info.address].memberOfGroup : '0';
            const deviceLocked = this.devices[info.address] ? this.devices[info.address].deviceLocked : false;
            let midiMsg;
            let stepsTaken;
            let direction;

            // If a polling is received then answer the polling to hold the device online
            if (msg_hex === POLL_REC) {
                this.log.silly(
                    `X-Touch received Polling from device ${info.address}, give an reply "${this.logHexData(POLL_REPLY)}"`,
                );

                this.setConnection(info.address, info.port, true);

                this.deviceSendData(this.fromHexString(POLL_REPLY), info.address, info.port);
            } else if (msg_hex === HOST_CON_QUERY) {
                this.log.silly(
                    `X-Touch received Host Connection Query, give no reply, probably "${this.logHexData(
                        HOST_CON_REPLY,
                    )}" in the future`,
                );
            } else {
                // other than polling and connection setup
                this.log.debug(
                    `-> ${msg.length} bytes from ${info.address}:${info.port}: <${this.logHexData(
                        msg_hex,
                    )}> org: <${msg.toString()}>`,
                );
                midiMsg = this.parseMidiData(msg);
                let baseId;
                const actPressed = midiMsg.value === '127' ? true : false;
                // check wheter desk is locked, let SysEx pass
                if (deviceLocked && midiMsg.msgType != 'SysEx') {
                    this.log.info(`X-Touch with address: ${info.address} is locked.`);
                    return;
                }

                switch (midiMsg.msgType) {
                    case 'NoteOff': // No NoteOff events for now, description wrong. Only NoteOn with dynamic 0
                        break;

                    case 'NoteOn': // NoteOn
                        baseId = this.midi2Objects[midiMsg.note]
                            ? `${this.namespace}.deviceGroups.${memberOfGroup}.${this.midi2Objects[midiMsg.note]}`
                            : '';
                        if (Number(midiMsg.note) >= 104 && Number(midiMsg.note) <= 112) {
                            // Fader touched, Fader 1 - 8 + Master
                            await this.handleFader(
                                baseId,
                                undefined,
                                actPressed ? 'touched' : 'released',
                                info.address,
                            );
                        } else if (Number(midiMsg.note) >= 46 && Number(midiMsg.note) <= 49) {
                            // fader or channel switch
                            if (actPressed) {
                                // only on butten press, omit release
                                let action = '';
                                switch (Number(midiMsg.note)) {
                                    case 46: // fader bank down
                                        action = 'bankDown';
                                        break;

                                    case 47: // fader bank up
                                        action = 'bankUp';
                                        break;

                                    case 48: // channel bank up
                                        action = 'channelDown';
                                        break;

                                    case 49: // channel bank down
                                        action = 'channelUp';
                                        break;
                                }
                                await this.deviceSwitchChannels(action, info.address);
                            }
                        } else {
                            await this.handleButton(
                                baseId,
                                undefined,
                                actPressed ? 'pressed' : 'released',
                                info.address,
                            );
                        }
                        break;

                    case 'Pitchbend': // Pitchbend (Fader value)
                        baseId = `${this.namespace}.deviceGroups.${memberOfGroup}`;
                        if (Number(midiMsg.channel) > 7) {
                            // Master Fader
                            baseId += '.masterFader';
                        } else {
                            baseId += `.banks.0.channels.${Number(midiMsg.channel) + 1}.fader`;
                        }
                        await this.handleFader(baseId, midiMsg.value, 'fader', info.address);
                        break;

                    case 'ControlChange': // Encoders do that
                        baseId = `${this.namespace}.deviceGroups.${memberOfGroup}`;
                        if (Number(midiMsg.controller) >= 16 && Number(midiMsg.controller) <= 23) {
                            // Channel encoder
                            baseId += `.banks.0.channels.${Number(midiMsg.controller) - 15}.encoder`;
                        } else {
                            baseId += '.transport.encoder';
                        }
                        //this.log.info(`midi message controller ${midiMsg.controller} value ${midiMsg.value}`);
                        stepsTaken = 1;
                        direction = 'cw';
                        if (midiMsg.value < 65) {
                            stepsTaken = midiMsg.value;
                        } else {
                            stepsTaken = midiMsg.value - 64;
                            direction = 'ccw';
                        }
                        await this.handleEncoder(baseId, stepsTaken, direction, info.address);
                        break;
                }
            }
        } catch (err) {
            this.errorHandler(err, 'onServerMessage');
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
     *
     * @param {string} buttonId                 full button id via onStateChange
     * @param {any | null | undefined} value    the value of the element
     * @param {string} event                    pressed, released, fader or value (value = when called via onStateChange)
     * @param {string} deviceAddress            only chen called via onServerMessage
     */
    async handleButton(buttonId, value = undefined, event = 'value', deviceAddress = '') {
        try {
            let baseId;
            let stateName = ''; // the name of the particular state when called via onStateChange
            const buttonArr = buttonId.split('.');
            let activeBank = 0;
            let activeBaseChannel = 1;
            let actStatus;
            let isDirty = false; // if true the button states has changed and must be sent

            if (buttonId === '') {
                this.log.debug('X-Touch button not supported');
                return;
            }

            if (event === 'value') {
                // when called via onStateChange there is the full button id, cut the last part for baseId
                baseId = buttonId.substring(0, buttonId.lastIndexOf('.'));
                stateName = buttonId.substring(buttonId.lastIndexOf('.') + 1);

                if (stateName === '') {
                    this.log.error('handleButton called with value and only baseId');
                    return; // if no value part provided throw an error
                }
                switch (stateName) {
                    case 'autoToggle':
                        // ToDo: check values and write back
                        this.deviceGroups[`${baseId}.autoToggle`].val = value; // only update the internal db
                        return;

                    case 'syncGlobal':
                        this.deviceGroups[`${baseId}.syncGlobal`].val = Boolean(value); // only update the internal db
                        return;

                    case 'flashing':
                        if (this.deviceGroups[`${baseId}.flashing`].val != Boolean(value)) {
                            // if changed send
                            this.deviceGroups[`${baseId}.flashing`].val = Boolean(value);
                            isDirty = true;
                        }
                        break;

                    case 'pressed':
                        event = value ? 'pressed' : 'released'; // if button press is simulated via state db
                        break;

                    default:
                        if (this.deviceGroups[`${baseId}.status`].val != Boolean(value)) {
                            // if changed send
                            this.deviceGroups[`${baseId}.status`].val = Boolean(value);
                            isDirty = true;
                        }
                }
            } else {
                // when called by midiMsg determine the real channel
                if (deviceAddress !== '' && this.devices[deviceAddress]) {
                    activeBank = this.devices[deviceAddress].activeBank;
                    activeBaseChannel = this.devices[deviceAddress].activeBaseChannel;
                }
                if (buttonArr[4] === 'banks') {
                    // replace bank and baseChannel on channel buttons
                    buttonArr[5] = activeBank.toString();
                    buttonArr[7] = (Number(buttonArr[7]) + activeBaseChannel - 1).toString();
                }
                baseId = buttonArr.join('.');
            }

            const buttonName = buttonArr.length > 8 ? buttonArr[8] : '';
            const actPressed = event === 'pressed' ? true : false;

            if (buttonName === 'encoder') {
                // encoder is only pressed event
                this.setState(`${baseId}.pressed`, actPressed, true);
            } else {
                actStatus = this.deviceGroups[`${baseId}.status`].val;
                let setValue = actStatus;

                if (event === 'value') {
                    setValue = Boolean(value);
                    isDirty = true;
                } else {
                    // handle the button auto mode

                    if (this.deviceGroups[`${baseId}.pressed`].val !== actPressed) {
                        // if status changed
                        this.deviceGroups[`${baseId}.pressed`].val = actPressed;
                        this.setState(`${baseId}.pressed`, actPressed, true);

                        switch (this.deviceGroups[`${baseId}.autoToggle`].val) {
                            case 0: // no auto function
                                break;

                            case 1: // tip
                                setValue = actPressed ? true : false;
                                break;

                            case 2: // on press
                                if (actPressed) {
                                    setValue = actStatus ? false : true;
                                }
                                break;

                            case 3: // on release
                                if (!actPressed) {
                                    setValue = actStatus ? false : true;
                                }
                                break;

                            case 4: // on press / release
                                if (actPressed && !actStatus) {
                                    setValue = true;
                                    this.deviceGroups[`${baseId}.autoToggle`].helperBool = true;
                                }
                                if (!actPressed && actStatus) {
                                    if (this.deviceGroups[`${baseId}.autoToggle`].helperBool) {
                                        this.deviceGroups[`${baseId}.autoToggle`].helperBool = false;
                                    } else {
                                        setValue = false;
                                    }
                                }
                                break;
                        }
                    }

                    if (this.deviceGroups[`${baseId}.status`].val !== setValue) {
                        // if status changed
                        this.deviceGroups[`${baseId}.status`].val = setValue;
                        this.setState(`${baseId}.status`, setValue, true);
                        isDirty = true;
                    }
                }

                if (isDirty) {
                    this.sendButton(baseId);
                }
            }
        } catch (err) {
            this.errorHandler(err, 'handleButton');
        }
    }

    /**
     * handle the fader events and call the sendback if someting is changed
     *
     * @param {string} faderId                  full fader id via onStateChange
     * @param {any | null | undefined} value    the value to handle
     * @param {string} event                    pressed, released or value (value = when called via onStateChange)
     * @param {string} deviceAddress            only chen called via onServerMessage
     */
    async handleFader(faderId, value = undefined, event = 'value', deviceAddress = '') {
        try {
            let baseId;
            let stateName = ''; // the name of the particular state when called via onStateChange
            const faderArr = faderId.split('.');
            let activeBank = 0;
            let activeBaseChannel = 1;
            let isDirty = false; // if true the fader states has changed and must be sent
            let locObj = this.calculateFaderValue(value, 'midiValue');

            if (faderId === '') {
                this.log.debug('X-Touch fader not supported');
                return;
            }

            if (event === 'value') {
                // if called via onStateChange there is the full fader id, cut the last part for baseId
                baseId = faderId.substring(0, faderId.lastIndexOf('.'));
                stateName = faderId.substring(faderId.lastIndexOf('.') + 1);

                switch (stateName) {
                    case 'syncGlobal':
                        this.deviceGroups[`${baseId}.syncGlobal`].val = Boolean(value); // only update the internal db
                        return;

                    case 'touched':
                        this.deviceGroups[`${baseId}.touched`].val = Boolean(value); // only update the internal db
                        return;

                    case 'value':
                        locObj = this.calculateFaderValue(value, 'linValue');
                        if (this.deviceGroups[`${baseId}.value`].val != locObj.linValue) {
                            this.deviceGroups[`${baseId}.value`].val = locObj.linValue;
                            this.deviceGroups[`${baseId}.value_db`].val = locObj.logValue;
                            isDirty = true;
                        }
                        this.setState(`${baseId}.value`, Number(locObj.linValue), true); // maybe correct the format
                        this.setState(`${baseId}.value_db`, Number(locObj.logValue), true); // update log value too
                        break;

                    case 'value_db':
                        locObj = this.calculateFaderValue(value, 'logValue');
                        if (this.deviceGroups[`${baseId}.value_db`].val != locObj.logValue) {
                            this.deviceGroups[`${baseId}.value_db`].val = locObj.logValue;
                            this.deviceGroups[`${baseId}.value`].val = locObj.linValue;
                            isDirty = true;
                        }
                        this.setState(`${baseId}.value_db`, Number(locObj.logValue), true); // maybe correct the format
                        this.setState(`${baseId}.value`, Number(locObj.linValue), true); // update lin value too
                        break;

                    default:
                        this.log.warn(`X-Touch unknown fader value: "${faderId}"`);
                        return;
                }
            } else {
                // if called by midiMsg determine the real channel
                if (deviceAddress !== '' && this.devices[deviceAddress]) {
                    activeBank = this.devices[deviceAddress].activeBank;
                    activeBaseChannel = this.devices[deviceAddress].activeBaseChannel;
                }
                if (faderArr[4] === 'banks') {
                    // replace bank and baseChannel
                    faderArr[5] = activeBank.toString();
                    faderArr[7] = (Number(faderArr[7]) + activeBaseChannel - 1).toString();
                }
                baseId = faderArr.join('.');

                if (event === 'touched') {
                    if (!this.deviceGroups[`${baseId}.touched`].val) {
                        // if status changed
                        this.deviceGroups[`${baseId}.touched`].val = true;
                        this.setState(`${baseId}.touched`, true, true);
                    }
                } else if (event === 'released') {
                    if (this.deviceGroups[`${baseId}.touched`].val) {
                        // if status changed
                        this.deviceGroups[`${baseId}.touched`].val = false;
                        this.setState(`${baseId}.touched`, false, true);
                    }
                } else if (event === 'fader') {
                    if (this.deviceGroups[`${baseId}.value`].val != locObj.linValue) {
                        this.deviceGroups[`${baseId}.value`].val = locObj.linValue;
                        this.setState(`${baseId}.value`, Number(locObj.linValue), true);
                        isDirty = true;
                    }
                    if (this.deviceGroups[`${baseId}.value_db`].val != locObj.logValue) {
                        this.deviceGroups[`${baseId}.value_db`].val = locObj.logValue;
                        this.setState(`${baseId}.value_db`, Number(locObj.logValue), true);
                        isDirty = true;
                    }
                } else {
                    this.log.error(`X-Touch handleFader received unknown event: "${event}"`);
                }
            }

            if (isDirty) {
                this.sendFader(baseId, deviceAddress, true);
            }
        } catch (err) {
            this.errorHandler(err, 'handleFader');
        }
    }

    /**
     * handle the display status and call the send back if someting is changed
     *
     * @param {string} displayId                only when called via onStateChange
     * @param {any | null | undefined} value    the value to handle
     */
    async handleDisplay(displayId, value = undefined) {
        try {
            const displayArr = displayId.split('.');
            const stateName = displayArr.length > 9 ? displayArr[9] : '';
            const baseId = displayId.substring(0, displayId.lastIndexOf('.'));
            if (value === undefined) {
                return;
            } // nothing to do
            if (stateName === '') {
                return;
            } // if only base id there is nothing to handle. only called via onStateChange. Sending is done via sendDisplay
            let color = Number(this.deviceGroups[`${baseId}.color`].val);
            let inverted = this.deviceGroups[`${baseId}.inverted`].val;
            let line1 = this.deviceGroups[`${baseId}.line1`].val || '';
            let line1_ct = this.deviceGroups[`${baseId}.line1_ct`].val;
            let line2 = this.deviceGroups[`${baseId}.line2`].val || '';
            let line2_ct = this.deviceGroups[`${baseId}.line2_ct`].val;

            switch (
                stateName // correction of malformed values
            ) {
                case 'color':
                    color = Number(value);
                    if (color < 0 || color > 7) {
                        color = 0;
                        this.setState(`${baseId}.color`, color, true);
                    }
                    this.deviceGroups[`${baseId}.color`].val = color.toString();
                    break;

                case 'inverted':
                    inverted = Boolean(value);
                    this.deviceGroups[`${baseId}.inverted`].val = inverted;
                    break;

                case 'line1':
                    line1 = value.toString();
                    if (!this.isASCII(line1)) {
                        line1 = '';
                        this.setState(`${baseId}.line1`, line1, true);
                    }
                    if (line1.length > 7) {
                        line1 = line1.substring(0, 7);
                        this.setState(`${baseId}.line1`, line1, true);
                    }
                    this.deviceGroups[`${baseId}.line1`].val = line1;
                    break;

                case 'line1_ct':
                    line1_ct = Boolean(value);
                    this.deviceGroups[`${baseId}.line1_ct`].val = line1_ct;
                    break;

                case 'line2':
                    line2 = value.toString();
                    if (!this.isASCII(line2)) {
                        line2 = '';
                        this.setState(`${baseId}.line2`, line2, true);
                    }
                    if (line1.length > 7) {
                        line1 = line1.substring(0, 7);
                        this.setState(`${baseId}.line1`, line1, true);
                    }
                    this.deviceGroups[`${baseId}.line2`].val = line2;
                    break;

                case 'line2_ct':
                    line2_ct = Boolean(value);
                    this.deviceGroups[`${baseId}.line2_ct`].val = line2_ct;
                    break;
            }

            this.sendDisplay(baseId);

            // ToDo: handle syncGlobal
        } catch (err) {
            this.errorHandler(err, 'handleDisplay');
        }
    }

    /**
     * handle the encoder status and call the send back if someting is changed
     *
     * @param {string} encoderId                only when called via onStateChange
     * @param {any | null | undefined} value    the value to handle
     * @param {string} event                    pressed, released or value (value = when called via onStateChange)
     * @param {string} deviceAddress            only chen called via onServerMessage
     */
    async handleEncoder(encoderId, value = undefined, event = 'value', deviceAddress = '') {
        try {
            let baseId;
            let stateName = ''; // the name of the particular state when called via onStateChange
            const encoderArr = encoderId.split('.');
            let activeBank = 0;
            let activeBaseChannel = 1;
            const deviceGroup = encoderArr[3];
            let actVal;
            let isDirty = false; // if true the encoder states has changed and must be sent

            if (encoderId === '') {
                this.log.debug('X-Touch encoder not supported');
                return;
            }

            if (event === 'value') {
                // when called via onStateChange there is the full encoder id, cut the last part for baseId
                baseId = encoderId.substring(0, encoderId.lastIndexOf('.'));
                stateName = encoderId.substring(encoderId.lastIndexOf('.') + 1);

                if (stateName === '') {
                    this.log.error('handleEncoder called with value and only baseId');
                    return; // if no value part provided throw an error
                }
                switch (stateName) {
                    case 'cw': // if wheel movement is simulated via database
                    case 'ccw': // only on encoder wheel possible
                        this.timers.devicegroup[deviceGroup].refresh(); // restart/refresh the timer
                        return;

                    case 'enabled':
                        if (this.deviceGroups[`${baseId}.enabled`].val != Boolean(value)) {
                            // if changed send
                            this.deviceGroups[`${baseId}.enabled`].val = Boolean(value);
                            isDirty = true;
                        }
                        break;

                    case 'mode':
                        if (value < 0 || value > 3 || !Number.isInteger(value)) {
                            value = 0;
                        } // correct ?
                        if (this.deviceGroups[`${baseId}.mode`].val != value) {
                            // if changed send
                            this.deviceGroups[`${baseId}.mode`].val = value;
                            isDirty = true;
                        }
                        break;

                    case 'pressed': // reset if sent via database
                        this.setState(`${baseId}.pressed`, false, true);
                        return;

                    case 'stepsPerTick': // check and correct
                        actVal = value;
                        if (value < 0) {
                            actVal = 0;
                        }
                        if (value > 1000) {
                            actVal = 1000;
                        }
                        if (!Number.isInteger(value)) {
                            actVal = parseInt(value, 10);
                        }
                        if (value != actVal) {
                            // value corrected ?
                            this.setState(`${baseId}.stepsPerTick`, Number(actVal), true);
                        }
                        if (this.deviceGroups[`${baseId}.stepsPerTick`].val != actVal) {
                            this.deviceGroups[`${baseId}.stepsPerTick`].val = actVal;
                            this.log.info(`handleEncoder changed the stepsPerTick to "${actVal}"`);
                        }
                        return;

                    case 'value':
                        if (value < 0) {
                            value = 0;
                        }
                        if (value > 1000) {
                            value = 1000;
                        }
                        if (!Number.isInteger(value)) {
                            value = parseInt(value, 10);
                        }
                        if (this.deviceGroups[`${baseId}.value`].val != value) {
                            this.deviceGroups[`${baseId}.value`].val = value;
                            this.setState(`${baseId}.value`, Number(value), true);
                        }
                        break;
                }
            } else {
                // when called by midiMsg determine the real channel
                if (deviceAddress !== '' && this.devices[deviceAddress]) {
                    activeBank = this.devices[deviceAddress].activeBank;
                    activeBaseChannel = this.devices[deviceAddress].activeBaseChannel;
                }
                if (encoderArr[4] === 'banks') {
                    // replace bank and baseChannel on channel encoders
                    encoderArr[5] = activeBank.toString();
                    encoderArr[7] = (Number(encoderArr[7]) + activeBaseChannel - 1).toString();
                }
                baseId = encoderArr.join('.');
            }

            if (encoderArr[5] === 'encoder') {
                // only on encoder wheel
                switch (event) {
                    case 'cw':
                        this.setState(`${baseId}.cw`, true, true);
                        this.timers.encoderWheels[deviceGroup].refresh(); // restart/refresh the timer
                        return; // nothing more to do

                    case 'ccw':
                        this.setState(`${baseId}.ccw`, true, true);
                        this.timers.encoderWheels[deviceGroup].refresh(); // restart/refresh the timer
                        return; // nothing more to do

                    default:
                        this.log.error(`handleEncoder called with unknown event ${event} on encoder wheel`);
                }
            }

            if (this.deviceGroups[`${baseId}.enabled`].val !== true && !isDirty) {
                return;
            } // no farther processing if encoder disabled, only to send the status disabled on value "enabled" changed

            actVal = this.deviceGroups[`${baseId}.value`].val;

            if (this.deviceGroups[`${baseId}.value`].helperNum == -1) {
                // first call
                this.deviceGroups[`${baseId}.value`].helperNum = this.calculateEncoderValue(actVal);
            }

            switch (event) {
                case 'cw': // rotate to increment value
                    actVal += this.deviceGroups[`${baseId}.stepsPerTick`].val * value; // value contains the steps taken
                    if (actVal > 1000) {
                        actVal = 1000;
                    }
                    break;

                case 'ccw': // rotate to decrement value
                    actVal -= this.deviceGroups[`${baseId}.stepsPerTick`].val * value;
                    if (actVal < 0) {
                        actVal = 0;
                    }
                    break;
            }

            this.deviceGroups[`${baseId}.value`].val = actVal;
            this.setState(`${baseId}.value`, actVal, true);

            if (this.deviceGroups[`${baseId}.value`].helperNum != this.calculateEncoderValue(actVal)) {
                this.deviceGroups[`${baseId}.value`].helperNum = this.calculateEncoderValue(actVal);
                // if display value changed send
                isDirty = true;
            }

            let logStr = `handleEncoder event: ${event} new value ${actVal} `;
            if (isDirty) {
                logStr += `going to send ${this.deviceGroups[`${baseId}.value`].helperNum}`;
                this.sendEncoder(baseId);
            }
            this.log.debug(logStr);
            // ToDo: handle syncGlobal
        } catch (err) {
            this.errorHandler(err, 'handleEncoder');
        }
    }

    /**
     * handle the timecode display character status and call the send back if someting is changed
     *
     * @param {string} charId                   only when called via onStateChange
     * @param {any | null | undefined} value    the value to handle
     */
    async handleDisplayChar(charId, value = undefined) {
        try {
            const characterArr = charId.split('.');
            const stateName = characterArr.length > 6 ? characterArr[6] : '';
            const baseId = charId.substring(0, charId.lastIndexOf('.'));
            if (value === undefined) {
                return;
            } // nothing to do
            if (stateName === '') {
                return;
            } // if only base id there is nothing to handle. only called via onStateChange. Sending is done via sendDisplayChar
            let char = this.deviceGroups[`${baseId}.char`].val || '';
            let dot = this.deviceGroups[`${baseId}.dot`].val || false;
            let enabled = this.deviceGroups[`${baseId}.enabled`].val || false;
            let extended = this.deviceGroups[`${baseId}.extended`].val;
            let mode = this.deviceGroups[`${baseId}.mode`].val;

            switch (
                stateName // correction of malformed values
            ) {
                case 'char':
                    char = value.toString();
                    if (!this.isASCII(char)) {
                        char = '';
                        this.setState(`${baseId}.char`, char, true);
                    }
                    if (char.length > 1) {
                        char = char.substring(0, 1);
                        this.setState(`${baseId}.char`, char, true);
                    }
                    this.deviceGroups[`${baseId}.char`].val = char;
                    break;

                case 'dot':
                    dot = Boolean(value);
                    this.deviceGroups[`${baseId}.dot`].val = dot;
                    break;

                case 'enabled':
                    enabled = Boolean(value);
                    this.deviceGroups[`${baseId}.enabled`].val = enabled;
                    break;

                case 'extended':
                    extended = Number(value);
                    if (extended < 0 || extended > 127) {
                        extended = 0;
                        this.setState(`${baseId}.extended`, extended, true);
                    }
                    this.deviceGroups[`${baseId}.extended`].val = extended.toString();
                    break;

                case 'mode':
                    mode = Number(value);
                    if (mode < 0 || mode > 1 || !Number.isInteger(mode)) {
                        mode = 0;
                        this.setState(`${baseId}.mode`, mode, true);
                    }
                    this.deviceGroups[`${baseId}.mode`].val = mode.toString();
                    break;
            }

            this.sendDisplayChar(baseId);

            // ToDo: handle syncGlobal
        } catch (err) {
            this.errorHandler(err, 'handleDisplayChar');
        }
    }

    /********************************************************************************
     * send functions to send back data to the device e.g. devices in the group
     ********************************************************************************
     *
     ********************************************************************************/
    /**
     * send back the button status, use same method to send the button state on restart and bank change
     *
     * @param {string} buttonId         the id of the button to send
     * @param {string} deviceAddress    only chen called via deviceUpdatexx
     * @param {boolean} blank           if blank is true the button will be turned off
     */
    async sendButton(buttonId, deviceAddress = '', blank = false) {
        try {
            this.log.silly(`Now send back button state of button: "${buttonId}"`);

            let selectedBank;
            let channelInBank;
            let isOnChannel = false; // if button is on channel to check whether it is aktually seen
            const buttonArr = buttonId.split('.');
            const realChannel = buttonArr[7];
            if (buttonArr[4] === 'banks') {
                // replace bank and baseChannel on channel buttons
                selectedBank = buttonArr[5];
                channelInBank = Number(buttonArr[7]) % 8 == 0 ? '8' : (Number(buttonArr[7]) % 8).toString();
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
            if (this.deviceGroups[`${buttonId}.status`].val) {
                // switch on
                if (this.deviceGroups[`${buttonId}.flashing`].val) {
                    midiVal = 1;
                } else {
                    midiVal = 127;
                }
            }
            if (blank) {
                midiVal = 0;
            } // switch off in case of clear desk
            const midiNote = this.objects2Midi[newArr.join('.')];
            const midiCommand = new Uint8Array([0x90, midiNote, midiVal]);

            for (const device of Object.keys(this.devices)) {
                if (deviceAddress !== device && deviceAddress !== '') {
                    continue;
                }
                // if called via deviceUpdate only send to the selected device
                if (this.devices[device].connection == false) {
                    continue;
                } // skip offine devices
                if (isOnChannel) {
                    if (
                        actDeviceGroup == this.devices[device].memberOfGroup &&
                        selectedBank == this.devices[device].activeBank &&
                        Number(realChannel) >= this.devices[device].activeBaseChannel &&
                        Number(realChannel) < this.devices[device].activeBaseChannel + 8
                    ) {
                        // only if button seen on console
                        this.deviceSendData(midiCommand, this.devices[device].ipAddress, this.devices[device].port);
                    }
                } else {
                    if (actDeviceGroup == this.devices[device].memberOfGroup) {
                        this.deviceSendData(midiCommand, this.devices[device].ipAddress, this.devices[device].port);
                    }
                }
                // ToDo: handle syncGlobal
            }
        } catch (err) {
            this.errorHandler(err, 'sendButton');
        }
    }

    /**
     * send back the fader status, use same method to send the fader state on restart and bank change
     *
     * @param {string} faderId          the fader id to send
     * @param {string} deviceAddress    only chen called via onServerMessage, to avoid sendback of fadervalue to device where it came from
     * @param {boolean} fromHw          then fromHw = true. From deviceUpdatexx fromHw = false -> send the the address, otherwise skip
     * @param {boolean} blank           if blank is true the button will be turned off
     */
    async sendFader(faderId, deviceAddress = '', fromHw = false, blank = false) {
        try {
            this.log.silly(`Now send back state of fader: "${faderId}"`);

            let selectedBank;
            let channelInBank;
            let isOnChannel = false; // if fader is on channel to check whether it is aktually seen
            const faderArr = faderId.split('.');
            const realChannel = faderArr[7];
            if (faderArr[4] === 'banks') {
                // replace bank and baseChannel on channel faders
                selectedBank = faderArr[5];
                channelInBank = Number(faderArr[7]) % 8 == 0 ? '8' : (Number(faderArr[7]) % 8).toString();
                // now "normalize" the array for lookup in the mapping
                faderArr[5] = '0';
                faderArr[7] = channelInBank;
                isOnChannel = true;
            }
            const actDeviceGroup = faderArr[3];
            const logObj = this.calculateFaderValue(this.deviceGroups[`${faderId}.value`].val, 'linValue');

            if (realChannel === undefined) {
                channelInBank = 9;
            } // only if Master Fader
            const statusByte = 0xe0 + Number(channelInBank) - 1;
            const dataByte2 = blank ? 0 : Math.floor(Number(logObj.midiValue) / 128).toFixed(0);
            const dataByte1 = blank ? 0 : Math.floor(Number(logObj.midiValue) - Number(dataByte2) * 128).toFixed(0);
            const midiCommand = new Uint8Array([statusByte, Number(dataByte1), Number(dataByte2)]);

            for (const device of Object.keys(this.devices)) {
                if (deviceAddress === device && fromHw) {
                    continue;
                }
                if (deviceAddress !== device && !fromHw) {
                    continue;
                }
                if (this.devices[device].connection == false) {
                    continue;
                } // skip offine devices
                if (isOnChannel) {
                    if (
                        actDeviceGroup == this.devices[device].memberOfGroup &&
                        selectedBank == this.devices[device].activeBank &&
                        Number(realChannel) >= this.devices[device].activeBaseChannel &&
                        Number(realChannel) < this.devices[device].activeBaseChannel + 8
                    ) {
                        // only if fader seen on console
                        //this.log.info(`send fader ${channelInBank} to ${device} value ${logObj.midiValue}`);
                        this.deviceSendData(midiCommand, this.devices[device].ipAddress, this.devices[device].port);
                    }
                } else {
                    if (actDeviceGroup == this.devices[device].memberOfGroup) {
                        //this.log.info(`send fader ${channelInBank} to ${device} value ${logObj.midiValue}`);
                        this.deviceSendData(midiCommand, this.devices[device].ipAddress, this.devices[device].port);
                    }
                }
                // ToDo: handle syncGlobal
            }
        } catch (err) {
            this.errorHandler(err, 'sendFader');
        }
    }

    /**
     * send back the display status
     *
     * @param {string} displayId        the display id to send
     * @param {string} deviceAddress    only chen called via deviceUpdatexx
     * @param {boolean} blank           if blank is true the button will be turned off
     */
    async sendDisplay(displayId, deviceAddress = '', blank = false) {
        try {
            let selectedBank;
            let channelInBank;
            let actDeviceGroup;
            const displayArr = displayId.split('.');
            const realChannel = displayArr[7];
            if (displayArr[4] === 'banks') {
                // replace bank and baseChannel on channel buttons
                actDeviceGroup = displayArr[3];
                selectedBank = displayArr[5];
                channelInBank = Number(displayArr[7]) % 8 == 0 ? '8' : (Number(displayArr[7]) % 8).toString();
            } else {
                this.log.error('sendDisplay called with a displayId with no banks identifier in it');
                return;
            }

            let baseId = displayId.substring(0, displayId.lastIndexOf('.'));
            const stateName = displayArr.length > 9 ? displayArr[9] : '';
            if (stateName === '') {
                baseId = displayId; // if called with no substate
            }
            let color = Number(this.deviceGroups[`${baseId}.color`].val);
            const inverted = this.deviceGroups[`${baseId}.inverted`].val;
            const line1 = this.deviceGroups[`${baseId}.line1`].val || '';
            const line1_ct = this.deviceGroups[`${baseId}.line1_ct`].val;
            const line2 = this.deviceGroups[`${baseId}.line2`].val || '';
            const line2_ct = this.deviceGroups[`${baseId}.line2_ct`].val;

            color = blank ? 0 : color; // switch of if blank

            this.log.silly(
                `Now send back state of display: "${displayId}", Color: "${color}", Lines: "${line1}, ${line2}"`,
            );

            let midiString = 'F000006658';
            midiString += `20${(32 + (Number(channelInBank) - 1)).toString(16)}`.slice(-2); // Add channel 20 - 27
            if (inverted) {
                midiString += `00${(color + 64).toString(16)}`.slice(-2);
            } else {
                midiString += `00${color.toString(16)}`.slice(-2);
            }
            for (let strPos = 0; strPos < 7; strPos++) {
                if (strPos < line1.length) {
                    midiString += `00${String(line1).charCodeAt(strPos).toString(16).toUpperCase()}`.slice(-2);
                } else {
                    midiString += line1_ct ? '00' : '20';
                }
            }
            for (let strPos = 0; strPos < 7; strPos++) {
                if (strPos < line2.length) {
                    midiString += `00${String(line2).charCodeAt(strPos).toString(16).toUpperCase()}`.slice(-2);
                } else {
                    midiString += line2_ct ? '00' : '20';
                }
            }
            midiString += 'F7';

            const midiCommand = this.fromHexString(midiString);
            // F0 00 00 66 58 20 8 48 61 6c 6c 6f 20 20 64 75 00 00 00 00 00 F7
            // 240,0,0,102,88,32,8,72,97,108,108,111,32,32,100,117,0,0,0,0,0,247

            if (deviceAddress) {
                // only send to this device (will only called with display which will be seen on this device)
                this.deviceSendData(midiCommand, deviceAddress, this.devices[deviceAddress].port);
            } else {
                // send to all connected devices on which this display is seen
                for (const device of Object.keys(this.devices)) {
                    if (this.devices[device].connection == false) {
                        continue;
                    } // skip offine devices
                    if (
                        actDeviceGroup == this.devices[device].memberOfGroup &&
                        selectedBank == this.devices[device].activeBank &&
                        Number(realChannel) >= this.devices[device].activeBaseChannel &&
                        Number(realChannel) < this.devices[device].activeBaseChannel + 8 &&
                        this.devices[device].connection
                    ) {
                        // only if display seen on console and device connected
                        this.deviceSendData(midiCommand, this.devices[device].ipAddress, this.devices[device].port);
                    }
                }
            }

            // ToDo: handle syncGlobal
        } catch (err) {
            this.errorHandler(err, 'sendDisplay');
        }
    }

    /**
     * send back the encoder status
     *
     * @param {string} encoderId        the encode id to send
     * @param {string} deviceAddress    only chen called via deviceUpdatexx
     * @param {boolean} blank           if blank is true the button will be turned off
     */
    async sendEncoder(encoderId, deviceAddress = '', blank = false) {
        try {
            let selectedBank;
            let channelInBank;
            let actDeviceGroup;
            const encoderArr = encoderId.split('.');
            const realChannel = encoderArr[7];
            if (encoderArr[4] === 'banks') {
                // replace bank and baseChannel on channel buttons
                actDeviceGroup = encoderArr[3];
                selectedBank = encoderArr[5];
                channelInBank = Number(encoderArr[7]) % 8 == 0 ? '8' : (Number(encoderArr[7]) % 8).toString();
            } else {
                this.log.error('sendEncoder called with a displayId with no banks identifier in it');
                return;
            }

            let baseId = encoderId.substring(0, encoderId.lastIndexOf('.'));
            const stateName = encoderArr.length > 9 ? encoderArr[9] : '';
            if (stateName === '') {
                baseId = encoderId; // if called with no substate
            }

            if (this.deviceGroups[`${baseId}.value`].helperNum == -1) {
                // first call
                this.deviceGroups[`${baseId}.value`].helperNum = this.calculateEncoderValue(
                    this.deviceGroups[`${baseId}.value`].val,
                );
            }

            const dispVal = this.deviceGroups[`${baseId}.value`].helperNum;
            const ccByte1Left = Number(channelInBank) + 47; // controller 48 - 55
            const ccByte1Right = Number(channelInBank) + 55; // controller 56 - 63
            let ccByte2Left = this.encoderMapping[`mode_${this.deviceGroups[`${baseId}.mode`].val}`][dispVal][0];
            let ccByte2Right = this.encoderMapping[`mode_${this.deviceGroups[`${baseId}.mode`].val}`][dispVal][1];

            if (this.deviceGroups[`${baseId}.enabled`].val != true || blank) {
                this.log.debug(`encoder "${baseId}" disabled. switch off`);
                ccByte2Left = 0;
                ccByte2Right = 0;
            }

            const midiCommand1 = new Uint8Array([0xb0, ccByte1Left, ccByte2Left]);
            const midiCommand2 = new Uint8Array([0xb0, ccByte1Right, ccByte2Right]);

            this.log.debug(
                `Now send back state of encoder: "${encoderId}", cc: "${ccByte1Left}:${ccByte1Right}", values: "${ccByte2Left}:${ccByte2Right}"`,
            );

            if (deviceAddress) {
                // only send to this device (will only called with display which will be seen on this device)
                this.deviceSendData(midiCommand1, deviceAddress, this.devices[deviceAddress].port);
                this.deviceSendData(midiCommand2, deviceAddress, this.devices[deviceAddress].port);
            } else {
                // send to all connected devices on which this display is seen
                for (const device of Object.keys(this.devices)) {
                    if (this.devices[device].connection == false) {
                        continue;
                    } // skip offine devices
                    if (
                        actDeviceGroup == this.devices[device].memberOfGroup &&
                        selectedBank == this.devices[device].activeBank &&
                        Number(realChannel) >= this.devices[device].activeBaseChannel &&
                        Number(realChannel) < this.devices[device].activeBaseChannel + 8 &&
                        this.devices[device].connection
                    ) {
                        // only if display seen on console and device connected
                        this.deviceSendData(midiCommand1, this.devices[device].ipAddress, this.devices[device].port);
                        this.deviceSendData(midiCommand2, this.devices[device].ipAddress, this.devices[device].port);
                    }
                }
            }

            // ToDo: handle syncGlobal
        } catch (err) {
            this.errorHandler(err, 'sendEncoder');
        }
    }

    /**
     * send back the display character status
     *
     * @param {string} charId           the character id to send
     * @param {string} deviceAddress    only chen called via deviceUpdatexx
     * @param {string|undefined} value  if value is set then send this value (character), used for locked devices
     */
    async sendDisplayChar(charId, deviceAddress = '', value = undefined) {
        try {
            const characterArr = charId.split('.');
            const actDeviceGroup = characterArr[3];
            const character = characterArr[5];
            const char = this.deviceGroups[`${charId}.char`].val || '';
            const dot = this.deviceGroups[`${charId}.dot`].val || false;
            const enabled = this.deviceGroups[`${charId}.enabled`].val || false;
            const extended = this.deviceGroups[`${charId}.extended`].val;
            const mode = this.deviceGroups[`${charId}.mode`].val;
            let controller = 0;
            let charCode = 0;

            this.log.debug(
                `Now send back character: "${character}", Enabled: "${enabled}", Mode: "${mode}", Char: "${char}", Extended: "${extended}", HasDot: "${dot}, forced value: ${value}"`,
            );

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

            if (value !== undefined) {
                // forced mode. Send back the gives value (character) if exists
                charCode = this.characterMapping[value] || 0;
            } else {
                // standard mode / behaviour
                if (mode == 0) {
                    charCode = this.characterMapping[char] || 0;
                } else {
                    charCode = extended || 0;
                }

                if (!enabled) {
                    this.log.debug(`character "${charId}" disabled. switch off`);
                    charCode = 0;
                } else {
                    if (dot) {
                        controller += 16;
                    }
                    // the controller number with dot
                    // only if enabled. When disabled send to controller without dot to switch of the dot
                }
            }

            const midiCommand = new Uint8Array([0xb0, controller, charCode]);

            if (deviceAddress) {
                // only send to this device (will only called with display which will be seen on this device)
                this.deviceSendData(midiCommand, deviceAddress, this.devices[deviceAddress].port);
            } else {
                // send to all connected devices on which this display is seen
                for (const device of Object.keys(this.devices)) {
                    if (this.devices[device].connection == false) {
                        continue;
                    } // skip offine devices
                    if (actDeviceGroup == this.devices[device].memberOfGroup && this.devices[device].connection) {
                        // only if display seen on console and device connected
                        this.deviceSendData(midiCommand, this.devices[device].ipAddress, this.devices[device].port);
                    }
                }
            }

            // ToDo: handle syncGlobal
        } catch (err) {
            this.errorHandler(err, 'sendDisplayChar');
        }
    }

    /**
     * switch the bank up and down
     *
     * @param {string} action               bankUp, bankDown, channelUp, channelDown, none, blank. action none used for illuminate the bank switches, blank for switching off the buttons in case the device is locked
     * @param {string} deviceAddress        only chen called via deviceUpdatexx
     */
    async deviceSwitchChannels(action = 'none', deviceAddress = '') {
        const activeGroup = this.devices[deviceAddress].memberOfGroup;
        const deviceIndex = this.devices[deviceAddress].index;
        let activeBank = this.devices[deviceAddress].activeBank;
        let activeBaseChannel = this.devices[deviceAddress].activeBaseChannel;
        let isDirty = false;

        try {
            switch (action) {
                case 'bankUp':
                    if (
                        activeBank + 1 <
                        this.deviceGroups[`${this.namespace}.deviceGroups.${activeGroup}.maxBanks`].val
                    ) {
                        // active bank is 0 based
                        activeBank++;
                        this.devices[deviceAddress].activeBank = activeBank;
                        this.setState(`devices.${deviceIndex}.activeBank`, Number(activeBank), true);
                        // on bank change reset the baseChannel to 1
                        activeBaseChannel = 1;
                        this.devices[deviceAddress].activeBaseChannel = activeBaseChannel;
                        this.setState(`devices.${deviceIndex}.activeBaseChannel`, Number(activeBaseChannel), true);
                        isDirty = true;
                    }
                    break;

                case 'bankDown':
                    if (activeBank > 0) {
                        activeBank--;
                        this.devices[deviceAddress].activeBank = activeBank;
                        this.setState(`devices.${deviceIndex}.activeBank`, Number(activeBank), true);
                        // on bank change reset the baseChannel to 1
                        activeBaseChannel = 1;
                        this.devices[deviceAddress].activeBaseChannel = activeBaseChannel;
                        this.setState(`devices.${deviceIndex}.activeBaseChannel`, Number(activeBaseChannel), true);
                        isDirty = true;
                    }
                    break;

                case 'channelUp':
                    if (
                        activeBaseChannel + 8 <
                        this.deviceGroups[
                            `${this.namespace}.deviceGroups.${activeGroup}.banks.${activeBank}.maxChannels`
                        ].val
                    ) {
                        activeBaseChannel += 8;
                        this.devices[deviceAddress].activeBaseChannel = activeBaseChannel;
                        this.setState(`devices.${deviceIndex}.activeBaseChannel`, Number(activeBaseChannel), true);
                        isDirty = true;
                    }
                    break;

                case 'channelDown':
                    if (activeBaseChannel > 8) {
                        activeBaseChannel -= 8;
                        this.devices[deviceAddress].activeBaseChannel = activeBaseChannel;
                        this.setState(`devices.${deviceIndex}.activeBaseChannel`, Number(activeBaseChannel), true);
                        isDirty = true;
                    }
                    break;
            }

            if (isDirty || action === 'none' || action === 'blank') {
                // only care of illumination if something changed or on action none or blank

                let midiNote;
                let midiCommand;

                // illuminate bank switching
                if (this.deviceGroups[`${this.namespace}.deviceGroups.${activeGroup}.illuminateBankSwitching`].val) {
                    // bankUp is possible ?
                    midiNote = this.objects2Midi['page.faderBankInc'];
                    if (
                        activeBank + 1 <
                        this.deviceGroups[`${this.namespace}.deviceGroups.${activeGroup}.maxBanks`].val
                    ) {
                        midiCommand = new Uint8Array([0x90, midiNote, action === 'blank' ? 0 : 127]);
                    } else {
                        midiCommand = new Uint8Array([0x90, midiNote, 0]);
                    }
                    this.deviceSendData(
                        midiCommand,
                        this.devices[deviceAddress].ipAddress,
                        this.devices[deviceAddress].port,
                    );

                    // bankDown is possible ?
                    midiNote = this.objects2Midi['page.faderBankDec'];
                    if (activeBank > 0) {
                        midiCommand = new Uint8Array([0x90, midiNote, action === 'blank' ? 0 : 127]);
                    } else {
                        midiCommand = new Uint8Array([0x90, midiNote, 0]);
                    }
                    this.deviceSendData(
                        midiCommand,
                        this.devices[deviceAddress].ipAddress,
                        this.devices[deviceAddress].port,
                    );
                }

                // illuminate channel switching
                if (this.deviceGroups[`${this.namespace}.deviceGroups.${activeGroup}.illuminateChannelSwitching`].val) {
                    // channelUp is possible ?
                    midiNote = this.objects2Midi['page.channelInc'];
                    if (
                        activeBaseChannel + 8 <
                        this.deviceGroups[
                            `${this.namespace}.deviceGroups.${activeGroup}.banks.${activeBank}.maxChannels`
                        ].val
                    ) {
                        midiCommand = new Uint8Array([0x90, midiNote, action === 'blank' ? 0 : 127]);
                    } else {
                        midiCommand = new Uint8Array([0x90, midiNote, 0]);
                    }
                    this.deviceSendData(
                        midiCommand,
                        this.devices[deviceAddress].ipAddress,
                        this.devices[deviceAddress].port,
                    );

                    // bankDown is possible ?
                    midiNote = this.objects2Midi['page.channelDec'];
                    if (activeBaseChannel > 8) {
                        midiCommand = new Uint8Array([0x90, midiNote, action === 'blank' ? 0 : 127]);
                    } else {
                        midiCommand = new Uint8Array([0x90, midiNote, 0]);
                    }
                    this.deviceSendData(
                        midiCommand,
                        this.devices[deviceAddress].ipAddress,
                        this.devices[deviceAddress].port,
                    );
                }
            }

            if (isDirty) {
                this.deviceUpdateChannels(deviceAddress);
            }
        } catch (err) {
            this.errorHandler(err, 'deviceSwitchBank');
        }
    }

    /**
     * Is called if a subscribed state changes
     *
     * @param {string} id                                   database id of the state which generates this event
     * @param {ioBroker.State | null | undefined} state     the state with value and acknowledge
     */
    async onStateChange(id, state) {
        try {
            if (state) {
                // The state was changed
                // this.log.debug(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
                if (!state.ack) {
                    // only react on not acknowledged state changes
                    if (state.lc === state.ts) {
                        // last changed and last updated equal then the value has changed
                        this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
                        const baseId = id.substring(0, id.lastIndexOf('.'));
                        const locObj = await this.getObjectAsync(baseId);
                        if (typeof locObj !== 'undefined' && locObj !== null) {
                            const locRole = typeof locObj.common.role !== 'undefined' ? locObj.common.role : '';
                            switch (locRole) {
                                case 'button':
                                    this.handleButton(id, state.val, 'value');
                                    break;

                                case 'level.volume':
                                    this.handleFader(id, state.val, 'value');
                                    break;

                                case 'info.display':
                                    this.handleDisplay(id, state.val);
                                    break;

                                case 'encoder':
                                    this.handleEncoder(id, state.val);
                                    break;

                                case 'displayChar':
                                    this.handleDisplayChar(id, state.val);
                                    break;
                            }
                        }
                        if (/max/.test(id)) {
                            this.log.warn(`X-Touch state ${id} changed. Please restart instance`);
                        }
                        if (/illuminate/.test(id)) {
                            this.log.info(`X-Touch lock state changed to: ${state.val} on baseId: ${baseId}`);
                        }
                        if (/deviceLocked/.test(id)) {
                            const tempObj = await this.getStateAsync(`${baseId}.ipAddress`);
                            if (tempObj && tempObj.val) {
                                const deviceAddress = tempObj.val.toString();
                                this.log.info(
                                    `X-Touch lock state changed to: ${state.val}. Device address: ${deviceAddress}`,
                                );
                                this.devices[deviceAddress].deviceLocked = state.val;
                                this.deviceUpdateDevice(deviceAddress);
                            }
                        }
                        if (/memberOfGroup/.test(id)) {
                            const tempObj = await this.getStateAsync(`${baseId}.memberOfGroup`);
                            if (tempObj && tempObj.val) {
                                const deviceAddress = tempObj.val.toString();
                                this.log.info(
                                    `X-Touch memberOfGroup changed to: ${state.val}. Device address: ${deviceAddress}`,
                                );
                                this.devices[deviceAddress].memberOfGroup = state.val;
                                this.deviceUpdateDevice(deviceAddress);
                            }
                        }
                    } else {
                        this.log.debug(`state ${id} only updated not changed: ${state.val} (ack = ${state.ack})`);
                    }
                }
            } else {
                // The state was deleted
                this.log.info(`state ${id} deleted`);
            }
        } catch (err) {
            this.errorHandler(err, 'onStateChange');
        }
    }

    /**
     * called for sending all elements on status update
     *
     * @param {string} deviceAddress send all elements, update, this device
     */
    async deviceUpdateDevice(deviceAddress) {
        try {
            // send all common buttons
            const activeGroup = this.devices[deviceAddress].memberOfGroup;
            let deskBlank = false;
            if (this.devices[deviceAddress].deviceLocked) {
                deskBlank = this.config.deviceLockedState >= 1 ? true : false;
            }
            for (const actButton of this.consoleLayout.buttons) {
                const baseId = `${this.namespace}.deviceGroups.${activeGroup}.${actButton}`;
                this.sendButton(baseId, deviceAddress, deskBlank);
            }
            // send all display characters
            let displayIndex = 0;
            for (const actDisplayChar of this.consoleLayout.displayChars) {
                const baseId = `${this.namespace}.deviceGroups.${activeGroup}.${actDisplayChar}`;
                let blankValue = '';
                if (this.config.deviceLockedState >= 2 && this.devices[deviceAddress].deviceLocked) {
                    // do this only if the device is locked and the configured locked state includes a text
                    blankValue = this.config.deviceLockedText.substring(displayIndex, displayIndex + 1);
                    displayIndex++;
                    this.log.debug(`actDisplayChar: ${actDisplayChar} blankValue: ${blankValue}`);
                    this.sendDisplayChar(baseId, deviceAddress, blankValue);
                } else if (this.config.deviceLockedState === 1 && this.devices[deviceAddress].deviceLocked) {
                    // only blanking
                    this.log.debug(`actDisplayChar: ${actDisplayChar} blanking`);
                    this.sendDisplayChar(baseId, deviceAddress, '');
                } else {
                    this.sendDisplayChar(baseId, deviceAddress);
                }
            }
            // and the active fader bank
            this.deviceUpdateChannels(deviceAddress, deskBlank);
            // and now send the master fader
            this.sendFader(
                `${this.namespace}.deviceGroups.${activeGroup}.masterFader`,
                deviceAddress,
                false,
                deskBlank,
            );
            // illuminate the page buttons
            this.deviceSwitchChannels(deskBlank ? 'blank' : 'none', deviceAddress);
        } catch (err) {
            this.errorHandler(err, 'deviceUpdateDevice');
        }
    }

    /**
     * called for sending all active channel elements on status update
     *
     * @param {string} deviceAddress    send all channels to this device
     * @param {boolean} blank           if blank is true the elements will be sent off (to clear the desk)
     */
    async deviceUpdateChannels(deviceAddress, blank = false) {
        const activeGroup = this.devices[deviceAddress].memberOfGroup;
        const activeBank = this.devices[deviceAddress].activeBank;
        const activeBaseChannel = this.devices[deviceAddress].activeBaseChannel; // is 1, 9, ... for addition
        try {
            // send the active fader bank elements
            // loop through all visible channels
            for (let baseChannel = 1; baseChannel < 9; baseChannel++) {
                // and there for the elements
                for (const actElement of this.consoleLayout.channel) {
                    const baseId = `${this.namespace}.deviceGroups.${activeGroup}.banks.${activeBank}.channels.${
                        activeBaseChannel - 1 + baseChannel
                    }.${actElement}`;
                    switch (actElement) {
                        case 'encoder':
                            this.sendEncoder(baseId, deviceAddress, blank);
                            break;

                        case 'display':
                            this.sendDisplay(baseId, deviceAddress, blank);
                            break;

                        case 'fader':
                            this.sendFader(baseId, deviceAddress, false, blank);
                            break;

                        default:
                            this.sendButton(baseId, deviceAddress, blank);
                    }
                }
            }
        } catch (err) {
            this.errorHandler(err, 'deviceUpdateChannels');
        }
    }

    /**
     * called for sending data (adding to the queue)
     *
     * @param {Buffer | Uint8Array | Array} data    the data to send
     * @param {string} deviceAddress                the address to send to
     * @param {string | number} devicePort          the port to send to
     */
    deviceSendData(data, deviceAddress, devicePort = 10111) {
        const sendData = {
            data: data,
            address: deviceAddress,
            port: devicePort,
        };
        // Add sendData to the buffer
        this.sendBuffer.push(sendData);

        if (!this.sendActive) {
            // if sending is possible
            this.deviceSendNext(undefined, 'send');
        }
    }

    /**
     * send next data in the queue
     *
     * @param {any} err         error when used as a callback
     * @param {string} event    event can be send=called from deviceSendData, hw=called from server.send, timer=called from the sendDelay timer
     */
    deviceSendNext(err = undefined, event = 'send') {
        //this.log.info(`called with event: ${event}`);
        if (err) {
            this.errorHandler(err, 'deviceSendNext (server error)');
        } else {
            switch (event) {
                case 'hw': // comming from server.send
                    //this.log.info('refreshing timer');
                    //this.timers.sendDelay.ref();
                    this.timers.sendDelay.refresh();
                    break;

                case 'timer':
                    //this.log.info('on timer');

                    if (this.sendBuffer.length > 0) {
                        this.sendActive = true; // for now only push to sendqueue possible
                        const locLen = this.sendBuffer.length;
                        const locBuffer = this.sendBuffer.shift();
                        const logData = locBuffer.data.toString('hex').toUpperCase();
                        this.log.debug(
                            `X-Touch send data (on timer): "${logData}" to device: "${locBuffer.address}" Send Buffer length: ${locLen}`,
                        );
                        this.server.send(
                            locBuffer.data,
                            locBuffer.port,
                            locBuffer.address,
                            this.deviceSendNext.bind(this, err, 'hw'),
                        );
                    } else {
                        this.log.silly('X-Touch send queue now empty (on timer)');
                        this.sendActive = false; // queue is empty for now
                    }
                    break;

                case 'send':
                    //this.log.info('on send');

                    if (this.sendBuffer.length > 0) {
                        this.sendActive = true; // for now only push to sendqueue possible
                        const locLen = this.sendBuffer.length;
                        const locBuffer = this.sendBuffer.shift();
                        const logData = locBuffer.data.toString('hex').toUpperCase();
                        this.log.debug(
                            `X-Touch send data (on send): "${logData}" to device: "${locBuffer.address}" Send Buffer length: ${locLen}`,
                        );
                        this.server.send(
                            locBuffer.data,
                            locBuffer.port,
                            locBuffer.address,
                            this.deviceSendNext.bind(this, err, 'hw'),
                        );
                    } else {
                        this.log.silly('X-Touch send queue now empty (on send)');
                        this.sendActive = false; // queue is empty for now
                    }
                    break;
            }
        }
    }

    /**
     * parse midi data, assume the data passed is complete (network transfer via udp)
     *
     * @param {Buffer} midiData the midi data to parse
     */
    parseMidiData(midiData) {
        try {
            const midiMsg = {
                msgType: '', // NoteOff, NoteOn, AftertouchPoly, ControlChange, ProgramChange, AftertouchMono, Pitchbend, SysEx
                channel: '', // 0 - 15
                note: '', // Number of note in message
                value: '', // dynamic value, controller value, program change value, pitchvalue etc.
                valueDB: '', // if a pichbend is received, convert it in a range of -70.0 to 10.0 (fader value)
                valueLin: '', // if a pichbend is received, convert it in a range of 0 to 1000 (fader value)
                controller: '', // Controller number (for ControlChange)
                programm: '', // Programm number (for ProgramChange)
                manufact: '', // Mannufacturer ID on a SysEx Message
                sysexMessage: '', // the message part of a SysEx message ?!?
            };
            const statusByte = midiData[0];
            let byte1 = 0;
            let byte2 = 0;
            if (midiData.length > 1) {
                byte1 = midiData[1];
            }
            if (midiData.length > 2) {
                byte2 = midiData[2];
            }

            const msgType = statusByte & 0xf0;
            const msgChannel = statusByte & 0x0f;
            const locValue = byte2 * 128 + byte1;
            const valObj = this.calculateFaderValue(locValue, 'midiValue');

            switch (msgType) {
                case 0x80: // NoteOff
                    midiMsg.msgType = 'NoteOff';
                    midiMsg.channel = msgChannel.toString();
                    midiMsg.note = byte1.toString();
                    midiMsg.value = byte2.toString();
                    this.log.debug(
                        `X-Touch received a "NoteOff" event on channel: "${midiMsg.channel}" note: "${
                            midiMsg.note
                        }" value: "${midiMsg.value}"`,
                    );
                    break;

                case 0x90: // NoteOn
                    midiMsg.msgType = 'NoteOn';
                    midiMsg.channel = msgChannel.toString();
                    midiMsg.note = byte1.toString();
                    midiMsg.value = byte2.toString();
                    this.log.debug(
                        `X-Touch received a "NoteOn" event on channel: "${midiMsg.channel}" note: "${
                            midiMsg.note
                        }" value: "${midiMsg.value}"`,
                    );
                    break;

                case 0xa0: // AftertouchPoly
                    midiMsg.msgType = 'AftertouchPoly';
                    midiMsg.channel = msgChannel.toString();
                    midiMsg.note = byte1.toString();
                    midiMsg.value = byte2.toString();
                    this.log.debug(
                        `X-Touch received a "AftertouchPoly" event on channel: "${midiMsg.channel}" note: "${
                            midiMsg.note
                        }" value: "${midiMsg.value}"`,
                    );
                    break;

                case 0xb0: // ControlChange
                    midiMsg.msgType = 'ControlChange';
                    midiMsg.channel = msgChannel.toString();
                    midiMsg.controller = byte1.toString();
                    midiMsg.value = byte2.toString();
                    this.log.debug(
                        `X-Touch received a "ControlChange" event on channel: "${midiMsg.channel}" controller: "${
                            midiMsg.controller
                        }" value: "${midiMsg.value}"`,
                    );
                    break;

                case 0xc0: // ProgramChange
                    midiMsg.msgType = 'ProgramChange';
                    midiMsg.channel = msgChannel.toString();
                    midiMsg.programm = byte1.toString();
                    this.log.debug(
                        `X-Touch received a "ProgramChange" event on channel: "${midiMsg.channel}" programm: "${
                            midiMsg.programm
                        }"`,
                    );
                    break;

                case 0xd0: // AftertouchMono
                    midiMsg.msgType = 'AftertouchMono';
                    midiMsg.channel = msgChannel.toString();
                    midiMsg.value = byte1.toString();
                    this.log.debug(
                        `X-Touch received a "AftertouchMono" event on channel: "${midiMsg.channel}" value: "${
                            midiMsg.value
                        }"`,
                    );
                    break;

                case 0xe0: // Pitchbend
                    midiMsg.msgType = 'Pitchbend';
                    midiMsg.channel = msgChannel.toString();
                    midiMsg.valueDB = valObj.logValue;
                    midiMsg.valueLin = valObj.linValue;
                    midiMsg.value = locValue.toFixed(0);
                    this.log.debug(
                        `X-Touch received a "Pitchbend" event on channel: "${midiMsg.channel}" value: "${
                            midiMsg.valueLin
                        }" value in dB: "${midiMsg.valueDB}" orginal value:"${locValue}"`,
                    );
                    break;

                case 0xf0: // SysEx
                    midiMsg.msgType = 'SysEx';
                    midiMsg.sysexMessage = 'bla bla';
                    this.log.debug('X-Touch received a "SysEx" event');
                    break;
            }
            return midiMsg;
        } catch (err) {
            this.errorHandler(err, 'parseMidiData');
        }
        return {};
    }

    /**
     * create the database (populate all values an delete unused)
     */
    async createDatabaseAsync() {
        this.log.debug('X-Touch start to create/update the database');

        // create the device groups
        for (let index = 0; index < this.config.deviceGroups; index++) {
            await this.createDeviceGroupAsync(index.toString());
        }

        // delete all unused device groups
        for (const key in await this.getAdapterObjectsAsync()) {
            const tempArr = key.split('.');
            if (tempArr.length < 5) {
                continue;
            }
            if (tempArr[2] === 'devices') {
                continue;
            }
            if (Number(tempArr[3]) >= this.config.deviceGroups) {
                await this.delObjectAsync(key);
            }
        }

        // and now delete the unused device groups base folder
        for (let index = this.config.deviceGroups; index <= 4; index++) {
            await this.delObjectAsync(`${this.namespace}.deviceGroups.${index}`);
        }

        this.log.debug('X-Touch finished up database creation');
    }

    /**
     * create the given deviceGroup
     *
     * @param {string} deviceGroup the device group to create
     */
    async createDeviceGroupAsync(deviceGroup) {
        try {
            await this.setObjectNotExistsAsync(`deviceGroups.${deviceGroup}`, this.objectTemplates.deviceGroup);
            for (const element of this.objectTemplates.deviceGroups) {
                await this.setObjectNotExistsAsync(`deviceGroups.${deviceGroup}.${element._id}`, element);

                if (element.common.role === 'button') {
                    // populate the button folder
                    for (const button of this.objectTemplates.button) {
                        await this.setObjectNotExistsAsync(
                            `deviceGroups.${deviceGroup}.${element._id}.${button._id}`,
                            button,
                        );
                    }
                }
                if (element.common.role === 'level.volume') {
                    // populate the fader folder
                    for (const fader of this.objectTemplates.levelVolume) {
                        await this.setObjectNotExistsAsync(
                            `deviceGroups.${deviceGroup}.${element._id}.${fader._id}`,
                            fader,
                        );
                    }
                }

                if (element.type === 'folder' && element._id !== 'banks') {
                    // populate the section, but not banks
                    await this.setObjectNotExistsAsync(`deviceGroups.${deviceGroup}.${element._id}`, element);

                    for (const sectElem of this.objectTemplates[element._id]) {
                        // find the section
                        await this.setObjectNotExistsAsync(
                            `deviceGroups.${deviceGroup}.${element._id}.${sectElem._id}`,
                            sectElem,
                        );

                        if (sectElem.common.role === 'button') {
                            // populate the button folder
                            for (const button of this.objectTemplates.button) {
                                await this.setObjectNotExistsAsync(
                                    `deviceGroups.${deviceGroup}.${element._id}.${sectElem._id}.${button._id}`,
                                    button,
                                );
                            }
                        }
                        if (sectElem.common.role === 'led') {
                            // populate the led folder
                            for (const button of this.objectTemplates.led) {
                                await this.setObjectNotExistsAsync(
                                    `deviceGroups.${deviceGroup}.${element._id}.${sectElem._id}.${button._id}`,
                                    button,
                                );
                            }
                        }
                        if (sectElem.common.role === 'level.volume') {
                            // populate the fader folder
                            for (const fader of this.objectTemplates.levelVolume) {
                                await this.setObjectNotExistsAsync(
                                    `deviceGroups.${deviceGroup}.${element._id}.${sectElem._id}.${fader._id}`,
                                    fader,
                                );
                            }
                        }
                        if (sectElem.common.role === 'value.volume') {
                            // populate the meter folder
                            for (const meter of this.objectTemplates.valueVolume) {
                                await this.setObjectNotExistsAsync(
                                    `deviceGroups.${deviceGroup}.${element._id}.${sectElem._id}.${meter._id}`,
                                    meter,
                                );
                            }
                        }
                        if (sectElem.common.role === 'encoder') {
                            // populate the encoder folder
                            for (const meter of this.objectTemplates.encoder) {
                                await this.setObjectNotExistsAsync(
                                    `deviceGroups.${deviceGroup}.${element._id}.${sectElem._id}.${meter._id}`,
                                    meter,
                                );
                            }
                        }
                        if (sectElem.common.role === 'displayChar') {
                            // populate the displayChar folder
                            for (const displayChar of this.objectTemplates.displayChar) {
                                await this.setObjectNotExistsAsync(
                                    `deviceGroups.${deviceGroup}.${element._id}.${sectElem._id}.${displayChar._id}`,
                                    displayChar,
                                );
                            }
                        }
                    }
                }
            }

            this.log.info(`create bank of devicegroup ${deviceGroup}`);
            await this.createBanksAsync(deviceGroup);
        } catch (err) {
            this.errorHandler(err, 'createDeviceGroupAsync');
        }
    }

    /**
     * create a number of banks as defines by maxBanks in the given device group
     *
     * @param {string} deviceGroup the device group to create banks for
     */
    async createBanksAsync(deviceGroup) {
        try {
            const tempObj = await this.getStateAsync(`deviceGroups.${deviceGroup}.maxBanks`);
            let maxBanks = tempObj && tempObj.val ? Number(tempObj.val) : 1;

            if (maxBanks > this.config.maxBanks) {
                maxBanks = this.config.maxBanks;
                this.setState(`deviceGroups.${deviceGroup}.maxBanks`, Number(maxBanks), true);
            }

            for (let index = 0; index < maxBanks; index++) {
                const activeBank = `deviceGroups.${deviceGroup}.banks.${index}`;

                await this.setObjectNotExistsAsync(activeBank, this.objectTemplates.bank);

                for (const element of this.objectTemplates.banks) {
                    await this.setObjectNotExistsAsync(`${activeBank}.${element._id}`, element);

                    if (element.common.role === 'button') {
                        // populate the button folder
                        for (const button of this.objectTemplates.button) {
                            await this.setObjectNotExistsAsync(`${activeBank}.${element._id}.${button._id}`, button);
                        }
                    }
                    if (element.common.role === 'level.volume') {
                        // populate the fader folder
                        for (const fader of this.objectTemplates.level_volume) {
                            await this.setObjectNotExistsAsync(`${activeBank}.${element._id}.${fader._id}`, fader);
                        }
                    }
                    if (element.common.role === 'value.volume') {
                        // populate the meter folder
                        for (const meter of this.objectTemplates.value_volume) {
                            await this.setObjectNotExistsAsync(`${activeBank}.${element._id}.${meter._id}`, meter);
                        }
                    }
                }

                await this.createChannelsAsync(deviceGroup, index.toString());
            }

            // delete all unused banks
            for (const key in await this.getAdapterObjectsAsync()) {
                const tempArr = key.split('.');
                if (tempArr.length < 6) {
                    continue;
                }
                if (tempArr[3] == deviceGroup && Number(tempArr[5]) >= maxBanks) {
                    await this.delObjectAsync(key);
                }
            }

            // and now delete the unused bank base folder
            for (let index = maxBanks; index <= this.config.maxBanks; index++) {
                await this.delObjectAsync(`${this.namespace}.deviceGroups.${deviceGroup}.banks.${index}`);
            }
        } catch (err) {
            this.errorHandler(err, 'createBanksAsync');
        }
    }

    /**
     * create a number of channels (faders)
     *
     * @param {string} deviceGroup  the device group to create channels for
     * @param {string} bank         the bank in the device group
     */
    async createChannelsAsync(deviceGroup, bank) {
        try {
            const tempObj = await this.getStateAsync(`deviceGroups.${deviceGroup}.banks.${bank}.maxChannels`);
            let maxChannels = tempObj && tempObj.val ? Number(tempObj.val) : 8;

            if (Number(maxChannels) % 8) {
                // if not a multiple of 8
                maxChannels = 8;
                this.setState(`deviceGroups.${deviceGroup}.banks.${bank}.maxChannels`, Number(maxChannels), true);
            }

            if (maxChannels > this.config.maxChannels) {
                maxChannels = this.config.maxChannels;
                this.setState(`deviceGroups.${deviceGroup}.banks.${bank}.maxChannels`, Number(maxChannels), true);
            }

            for (let channel = 1; channel <= maxChannels; channel++) {
                const activeChannel = `deviceGroups.${deviceGroup}.banks.${bank}.channels.${channel}`;

                await this.setObjectNotExistsAsync(activeChannel, this.objectTemplates.channel);

                for (const element of this.objectTemplates.channels) {
                    await this.setObjectNotExistsAsync(`${activeChannel}.${element._id}`, element);

                    if (element.common.role === 'button') {
                        // populate the button folder
                        for (const button of this.objectTemplates.button) {
                            await this.setObjectNotExistsAsync(`${activeChannel}.${element._id}.${button._id}`, button);
                        }
                    }
                    if (element.common.role === 'level.volume') {
                        // populate the fader folder
                        for (const fader of this.objectTemplates.levelVolume) {
                            await this.setObjectNotExistsAsync(`${activeChannel}.${element._id}.${fader._id}`, fader);
                        }
                    }
                    if (element.common.role === 'value.volume') {
                        // populate the meter folder
                        for (const meter of this.objectTemplates.valueVolume) {
                            await this.setObjectNotExistsAsync(`${activeChannel}.${element._id}.${meter._id}`, meter);
                        }
                    }
                    if (element.common.role === 'info.display') {
                        // populate the meter folder
                        for (const display of this.objectTemplates.infoDisplay) {
                            await this.setObjectNotExistsAsync(
                                `${activeChannel}.${element._id}.${display._id}`,
                                display,
                            );
                        }
                    }
                    if (element.common.role === 'encoder') {
                        // populate the encoder folder
                        for (const display of this.objectTemplates.channelEncoder) {
                            await this.setObjectNotExistsAsync(
                                `${activeChannel}.${element._id}.${display._id}`,
                                display,
                            );
                        }
                    }
                }
            }

            // delete all unused channels
            for (const key in await this.getAdapterObjectsAsync()) {
                const tempArr = key.split('.');
                if (tempArr.length < 9) {
                    continue;
                }
                if (tempArr[3] == deviceGroup && tempArr[5] === bank && Number(tempArr[7]) > maxChannels) {
                    await this.delObjectAsync(key);
                }
            }

            // and now delete the unused channel base folder
            for (let index = maxChannels + 1; index <= this.config.maxChannels; index++) {
                await this.delObjectAsync(
                    `${this.namespace}.deviceGroups.${deviceGroup}.banks.${bank}.channels.${index}`,
                );
            }
        } catch (err) {
            this.errorHandler(err, 'createChannelsAsync');
        }
    }

    /**
     * map the given hex string to a UInt8Array
     *
     * @param {string} hexString the hexadeecimal formed string to parse to an int value
     */
    fromHexString(hexString) {
        // @ts-expect-error could but will not be NULL
        return new Uint8Array(hexString.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    }

    /**
     * format the given hex string to a byte separated form
     *
     * @param {string} locStr create a string in byte and space form to log
     */
    logHexData(locStr) {
        let retStr = '';
        for (let i = 0; i < locStr.length; i += 2) {
            retStr += `${locStr.substring(i, i + 2)} `;
        }
        retStr = retStr.substring(0, retStr.length - 1);
        return retStr;
    }

    /**
     * check whether the given string is ASCII 7-bit only
     *
     * @param {string} str string to test whether it is an ascii string
     */
    isASCII(str) {
        // eslint-disable-next-line no-control-regex
        return /^[\x00-\x7F]*$/.test(str);
    }

    /**
     * calculate midiValue -> linValue -> logValue and back
     *
     * @param {number | string | undefined} value   the value to calculate the real value from
     * @param {string} type                         Type of value provided
     * midiValue, linValue, logValue
     * returns: Object with all 3 value types
     */
    calculateFaderValue(value, type = 'midiValue') {
        if (typeof value === 'undefined') {
            return {};
        }
        if (typeof value === 'string') {
            value = Number(value);
        }

        const locObj = {};

        try {
            switch (type) {
                case 'midiValue':
                    value = value > 16380 ? 16380 : value;
                    value = value < 0 ? 0 : value;

                    locObj.midiValue = value.toFixed(0);
                    locObj.linValue = ((value / 16380) * 1000).toFixed(0);

                    if (value < 4400) {
                        locObj.logValue = ((value - 8800) / 110 + 10).toFixed(1);
                    } else if (value < 8650) {
                        locObj.logValue = ((value - 12890) / 212.5 + 10).toFixed(1);
                    } else {
                        locObj.logValue = ((value - 16380) / 386.5 + 10).toFixed(1);
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
                        locObj.logValue = ((calVal - 8800) / 110 + 10).toFixed(1);
                    } else if (calVal < 8650) {
                        locObj.logValue = ((calVal - 12890) / 212.5 + 10).toFixed(1);
                    } else {
                        locObj.logValue = ((calVal - 16380) / 386.5 + 10).toFixed(1);
                    }
                    break;

                case 'logValue':
                    value = value > 10.0 ? 10.0 : value;
                    value = value < -70.0 ? -70.0 : value;

                    locObj.logValue = value.toFixed(1);

                    value = value - 10;
                    if (value > -20) {
                        locObj.midiValue = (value * 386.5 + 16380).toFixed(0);
                    } else if (value > -40) {
                        locObj.midiValue = (value * 212.5 + 12900).toFixed(0);
                    } else {
                        locObj.midiValue = (value * 110 + 8800).toFixed(0);
                    }

                    locObj.linValue = ((Number(locObj.midiValue) / 16380) * 1000).toFixed(0);
                    break;
            }
        } catch (err) {
            this.errorHandler(err, 'calculateFaderValue');
        }

        return locObj;
    }

    /**
     * calculate encoder display value 0 - 1000 to 0 - 12
     *
     * @param {*} value the value to calculate the encode value from
     */
    calculateEncoderValue(value) {
        return parseInt((value / 77).toString(), 10);
    }

    /**
     * Called for creating a new file for recording
     *
     * @returns {string} the name of the actual export file
     */
    createExportFile() {
        try {
            const locDateObj = new Date();
            // current date
            // current month
            const locMonth = `0${locDateObj.getMonth() + 1}`.slice(-2);
            // current day
            const locDay = `0${locDateObj.getDate()}`.slice(-2);
            // current year
            const locYear = locDateObj.getFullYear();
            // current hours
            const locHours = `0${locDateObj.getHours()}`.slice(-2);
            // current minutes
            const locMinutes = `0${locDateObj.getMinutes()}`.slice(-2);
            // current seconds
            const locSeconds = `0${locDateObj.getSeconds()}`.slice(-2);
            // now create the filename
            return `${locYear}${locMonth}${locDay}_${locHours}${locMinutes}${locSeconds}_X-Touch_Export.json`;
            // file will be written using the iobroker writefile utility
        } catch (err) {
            this.errorHandler(err, 'createExportFile');
        }
        return '';
    }

    /**
     * Called on error situations and from catch blocks
     *
     * @param {any} err         the error to log
     * @param {string} module   optional, the module from where the error was generarted
     */
    errorHandler(err, module = '') {
        this.log.error(`X-Touch error in method: [${module}] error: ${err.message}, stack: ${err.stack}`);
    }

    /**
     * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
     * Using this method requires 'common.messagebox' property to be set to true in io-package.json
     *
     * @param {ioBroker.Message} obj the message object passed by js-controller
     */
    async onMessage(obj) {
        try {
            if (typeof obj === 'object' && obj.command) {
                this.log.info(`X-Touch message: ${JSON.stringify(obj)}`);
                if (obj.command === 'export') {
                    // export values of the actual instance
                    this.log.info('X-Touch exporting values');

                    const exportFile = this.createExportFile();
                    const device_states = await this.getStatesOfAsync('deviceGroups');
                    const exportDeviceStates = {};
                    let tempObj;
                    let deviceObj;
                    for (const device_state of device_states) {
                        deviceObj = device_state;
                        tempObj = await this.getStateAsync(device_state._id);
                        // @ts-expect-error val could be NULL but is not
                        deviceObj.val = tempObj && tempObj.val !== undefined ? tempObj.val : '';
                        exportDeviceStates[deviceObj._id] = deviceObj;
                    }
                    this.writeFileAsync('x-touch.0', exportFile, JSON.stringify(exportDeviceStates, null, 2));

                    // Send response in callback
                    if (obj.callback) {
                        this.sendTo(obj.from, obj.command, `values exported to: "${exportFile}"`, obj.callback);
                    }
                } else if (obj.command === 'import') {
                    // export values of the actual instance
                    this.log.info('X-Touch importing values');

                    let importFile = 'file' in Object(obj.message) ? Object(obj.message).file : '';
                    const importPath = 'path' in Object(obj.message) ? Object(obj.message).path : '';
                    const importDeviceGroup =
                        'devicegroup' in Object(obj.message) ? Object(obj.message).devicegroup : '';
                    const importFiles = [];
                    let importJson;
                    let importContent;

                    if (importPath !== '') {
                        // look in the filesystem
                        // try to read the given file. If not exists run to the error portion
                        importJson = JSON.parse(fs.readFileSync(`${importPath}/${importFile}`, 'utf8'));
                    } else {
                        // look in the adapters file section
                        const tempDir = await this.readDirAsync('x-touch.0', '/');
                        for (const file of tempDir) {
                            if (file.isDir) {
                                continue;
                            } // skip directories
                            if (file.file === importFile) {
                                this.log.debug(`Importfile "${importFile}" found.`);
                                importFiles.push(importFile); // for later existance in array
                                break;
                            }
                            const fileName = file.file;
                            if (fileName.split('.').pop() !== 'json') {
                                continue;
                            }
                            importFiles.push(fileName);
                        }
                        importFiles.sort();
                        if (importFile === '') {
                            importFile = importFiles[importFiles.length - 1];
                        } // if none specified pop the last in array
                        if (!importFiles.includes(importFile)) {
                            throw { message: `File "${importFile}" does not exist in directory` };
                        }
                        // try to read the file
                        importContent = await this.readFileAsync('x-touch.0', importFile);
                        // @ts-expect-error the file must exist at this stage
                        importJson = JSON.parse(importContent.data.toString());
                        this.log.debug(`File "${importFile}" red`);
                    }

                    for (const dbObject of Object.keys(importJson)) {
                        // iterate through the file elements
                        if (dbObject.substring(0, 22) !== 'x-touch.0.deviceGroups') {
                            continue;
                        } // skip foreign objects
                        if (dbObject.substring(23, 24) !== importDeviceGroup && importDeviceGroup !== '') {
                            continue;
                        } // skip unselected devicegroups
                        if (await this.getStateAsync(dbObject)) {
                            // Object exists in db
                            if (
                                importJson[dbObject].val !== undefined &&
                                importJson[dbObject].common.write !== undefined &&
                                importJson[dbObject].common.write
                            ) {
                                this.log.debug(
                                    `Setting object: "${dbObject}" with value: "${importJson[dbObject].val}"`,
                                );
                                this.setState(dbObject, importJson[dbObject].val, false); // set as not acknowledged so it will be transmitted immediate to the X-Touch
                            }
                        }
                    }

                    // Send response in callback
                    if (obj.callback) {
                        this.sendTo(obj.from, obj.command, `values imported from file "${importFile}"`, obj.callback);
                    }
                } else {
                    // export values of the actual instance
                    this.log.warn(
                        `X-Touch received unknown command "${obj.command}" with message "${JSON.stringify(obj.message)}"`,
                    );
                    // Send response in callback
                    if (obj.callback) {
                        this.sendTo(
                            obj.from,
                            obj.command,
                            `unknown command : "${obj.command}" with message "${JSON.stringify(obj.message)}"`,
                            obj.callback,
                        );
                    }
                }
            }
        } catch (err) {
            this.errorHandler(err, 'onMessage');
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param {() => void} callback callback given by js-controller to call under any circumstance
     */
    onUnload(callback) {
        try {
            // Reset the connection indicator
            this.setState('info.connection', false, true);

            // Here you must clear all timeouts or intervals that may still be active
            // and for all devices set not connected
            for (const element of Object.keys(this.devices)) {
                this.setState(`devices.${this.devices[element].index}.connection`, false, true);
                if (this.devices[element].timerDeviceInactivityTimeout) {
                    this.devices[element].timerDeviceInactivityTimeout.clearTimeout();
                }
            }

            // close the server port
            this.server.close(callback);
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (e) {
            callback();
        }
    }
}

// @ts-expect-error parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */

    module.exports = options => new XTouch(options);
} else {
    // otherwise start the instance directly
    new XTouch();
}
