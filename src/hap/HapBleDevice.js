"use strict";

const EventEmitter = require('events').EventEmitter;

const HapExecutor = require('./HapExecutor');

class HapBleDevice extends EventEmitter {
  constructor(log, peripheral, manufacturerData) {
    super();

    this.log = log;

    this._peripheral = peripheral;
    this.manufacturerData = manufacturerData;
    this._isAuthenticated = false;

    this.uuid = peripheral.uuid;
    this.address = peripheral.address;
    this.name = peripheral.advertisement.localName;
    this.rssi = peripheral.rssi;
    this.state = 'disconnected';
    this.isPaired = manufacturerData.isPaired;
    this.ignore = false;

    this.services = undefined;
    this.characteristics = undefined;

    this.executor = new HapExecutor(this.log, this);

    this._pendingOperations = [];
    this._transactionId = Math.floor(Math.random() * 255);

    this._peripheral.on('connect', this._onConnected.bind(this));
    this._peripheral.on('disconnect', this._onDisconnected.bind(this));
  }

  getCharacteristic(address) {

    if (!this.services) {
      throw new Error('Not connected.');
    }

    const serviceId = address.service.replace(/-/g, '').toLowerCase();
    const characteristicId = address.characteristic.replace(/-/g, '').toLowerCase();

    const service = this.services.find(svc => svc.uuid == serviceId);
    if (service) {
      const characteristic = service.characteristics.find(c => c.uuid === characteristicId);
      return characteristic;
    }

    throw new Error('Unknown service/characteristic address.');
  }

  async connect() {
    if (this.state === 'connected') {
      return;
    }

    /**
     * RPi noble sometimes has connectivity issues by disconnecting immediately
     * after a connection has been established.
     * 
     * This loop attempts to connect three times and waits afterwards to see if
     * a connection has been established. Gives up after three times.
     * 
     * See https://github.com/sandeepmistry/noble/issues/465
     * 
     */
    for (let n = 0; n < 3 && this.state !== 'connected'; n++) {
      await this._connect();
      await this._sleep(100);
    }

    if (this.state !== 'connected') {
      this.log(`noble failed to establish a BLE connection to ${this.name}`);
      throw new Error(`noble failed to establish a BLE connection to ${this.name}`);
    }

    await this._discoverServicesAndCharacteristics();
    if (this.isPaired) {
      this._subscribeToIndicatingCharacteristics();
    }
  }

  _connect() {
    return new Promise((resolve, reject) => {
      this._peripheral.connect((error) => {
        if (error) {
          reject(error);
        }

        resolve();
      });
    });
  }

  _sleep(timeout) {
    return new Promise(resolve => {
      setTimeout(resolve, timeout);
    });
  }

  _onConnected() {
    if (this.state !== 'connected') {
      this.state = 'connected';
      this.log(`Connected to ${this.name}`);
    }
  }

  async disconnect() {
    if (this.state === 'disconnected') {
      return;
    }

    await this._disconnect();
  }

  _disconnect() {
    return new Promise((resolve, reject) => {
      this._peripheral.disconnect((error) => {
        if (error) {
          reject(error);
        }

        resolve();
      });
    });
  }

  _onDisconnected() {
    if (this.state !== 'disconnected') {
      this.state = 'disconnected';
      this.log(`Disconnected from ${this.name}`);

      // Reset the discovered state
      this.services = undefined;
      this.characteristics = undefined;

      // Cancel pending BLE operations
      this._rejectPendingOperations();
    }
  }

  _discoverServicesAndCharacteristics() {
    return new Promise((resolve, reject) => {
      this._peripheral.discoverServices(null, (error, services) => {
        this.log("Discovered services.");
        if (error) {
          reject(error);
        }

        this.services = services;

        const allCharacteristics = [];
        let pendingServices = this.services.length;

        this.services.forEach(svc => {
          svc.discoverCharacteristics(null, (error, characteristics) => {
            if (error) {
              reject(error);
            }

            allCharacteristics.push(characteristics);
            pendingServices--;
            if (pendingServices == 0) {
              this.log(`Discovered GATT services and characteristics of ${this.name}`);
              this.characteristics = allCharacteristics;
              resolve();
            }
          });
        });
      });
    });
  }

  /**
   * Queues a request object on the device for execution.
   * 
   * @param {Request} cmd The request to execute on the device.
   * 
   * @returns Promise that represents the execution state of the command.
   * 
   */
  run(cmd) {
    return this.executor.run(cmd);
  }

  write(c, buffer) {
    // Send the packet
    return new Promise((resolve, reject) => {

      this._registerPendingOperation(reject);

      c.once('write', () => {
        resolve();
        this._unregisterPendingOperation(reject);
      });

      c.write(buffer, false);
    });
  }

  read(c) {
    return new Promise((resolve, reject) => {
      this._registerPendingOperation(reject);
      c.once('data', (data, isNotification) => {
        resolve(data);
        this._unregisterPendingOperation(reject);
      });

      c.read();
    });
  }

  updateManufacturerData(data) {
    const hasGSNChanged = data.gsn != this.manufacturerData.gsn;
    this.manufacturerData = data;
    this.isPaired = data.isPaired;

    if (hasGSNChanged) {
      this.log(`Device ${this.name} issues a disconnected event.`);
      this.emit('disconnected-event');
    }
  }

  _registerPendingOperation(reject) {
    this._pendingOperations.push(reject);
  }

  _unregisterPendingOperation(reject) {
    const index = this._pendingOperations.indexOf(reject);
    if (index !== -1) {
      this._pendingOperations.splice(index, 1);
    }
  }

  _rejectPendingOperations() {
    if (this._pendingOperations.length !== 0) {
      const e = new Error('Disconnected');

      this._pendingOperations.forEach(reject => {
        reject(e);
      });
      this._pendingOperations = [];
    }
  }

  _subscribeToIndicatingCharacteristics() {
    this.services.forEach(svc => {
      svc.characteristics.forEach(c => {
        if (c.properties.indexOf('indicate') != -1) {
          c.subscribe();

          c.on('data', (data, isNotification) => {
            if ((data && data.length === 0) || isNotification) {
              const address = {
                service: svc.uuid,
                characteristic: c.uuid
              };

              this.log(`Connected event on service ${svc.uuid} for characteristic ${c.uuid}`);
              this.emit('connected-event', address);
            }
          });
        }
      });
    });
  }
};

module.exports = HapBleDevice;
