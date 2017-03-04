//'use strict';
var inherits = require('util').inherits;
var schedule = require('node-schedule');
var Service, Characteristic;
var mqtt = require('mqtt');

module.exports = function(homebridge) {
	Service = homebridge.hap.Service;
	Characteristic = homebridge.hap.Characteristic;

	homebridge.registerAccessory('homebridge-mqtt-power-consumption-log-tasmota', 'mqtt-power-consumption-log-tasmota', MqttPowerConsumptionTasmotaAccessory);
};

function convertDateTofilename(date) {
	date = new Date(date);
	var localOffset = date.getTimezoneOffset() * 60000;
	var localTime = date.getTime();
	date = localTime - localOffset;
	date = new Date(date).toISOString().replace(/T.+/, '');
	return date;
}

function convertDateUTCDtoLocalStr(date, timeOffset) {
	date = new Date(date);
	var localOffset;
	if (timeOffset != 0) {
		localOffset = timeOffset * 60000;
	} else {
		localOffset = date.getTimezoneOffset() * 60000;
	}
	var localTime = date.getTime();
	date = localTime - localOffset;
	date = (new Date(date)).toISOString().replace(/T/, ' ').replace(/\..+/, '');
	return date;
}

function MqttPowerConsumptionTasmotaAccessory(log, config) {
	this.fs = require("graceful-fs");

	this.log = log;
	this.name = config["name"] || "Sonoff";
	this.manufacturer = config['manufacturer'] || "ITEAD";
	this.model = config['model'] || "Sonoff";
	this.serialNumberMAC = config['serialNumberMAC'] || "";

	this.timeOffset = parseInt(config["timeOffset"]) || 0;

	this.url = config['url'];

	this.topicStatusGet = config["topics"].statusGet;
	this.topicStatusSet = config["topics"].statusSet;
	this.onValue = config["onValue"];
	this.offValue = config["offValue"];
	this.topics = config['topics'];

	this.filename = this.topicStatusGet.split("/")[1];
	this.savePeriod = parseInt(config["savePeriod"]) || 15; // in minutes.
	this.savePeriod = this.savePeriod <= 0 ? 0 : this.savePeriod < 5 ? 5 : this.savePeriod; // min. period 5 minutes
	// SKASOWAĆ PO TESTACH!!! // SKASOWAĆ PO TESTACH!!!// SKASOWAĆ PO TESTACH!!!// SKASOWAĆ PO TESTACH!!!// SKASOWAĆ PO TESTACH!!!
	// this.savePeriod = "1"; // SKASOWAĆ PO TESTACH!!!
	// SKASOWAĆ PO TESTACH!!! // SKASOWAĆ PO TESTACH!!!// SKASOWAĆ PO TESTACH!!!// SKASOWAĆ PO TESTACH!!!// SKASOWAĆ PO TESTACH!!!
	this.patchToSave = config["patchToSave"] || false;
	if (this.patchToSave) {
		try {
			this.fs.statSync(this.patchToSave);
		} catch (e) {
			this.log("Problem ze ścieżką: ", this.patchToSave, e);
			try {
				this.fs.statSync("/tmp/");
				this.patchToSave = "/tmp/";
			} catch (e) {
				this.patchToSave = false;
			}
		}
	}

	this.outletNowInUse = true;
	this.outletInUseCurrent = 0.0;
	this.totalPowerConsumption = 0.0;
	this.powerConsumption = 0;
	this.powerConsumptionAV = 0.0;
	this.powerFactor = 1.0;
	this.amperage = 0.0;
	this.voltage = 0.0;

	this.lastPeriodkWhReset = this.lastHourkWhReset = this.todaykWhReset = false;
	this.lastPeriodNewData = this.lastHourNewData = this.todayNewData = false;

	this.lastToSave = {
		totalkWh: 0.0,
		todaykWh: 0.0,
		lastTodaykWh: 0.0,
		lastHourkWh: 0.0,
		lastPeriodkWh: 0.0,
		lastTimeStamp: "",
		lastEror: ""
	};

	if (config["outletInUseBy"] !== undefined) {
		this.outletUseByCurrent = config["outletInUseBy"] == "current";
		if (config["outletInUseCurrent"] !== undefined) {
			this.outletInUseCurrent = parseFloat(config["outletInUseCurrent"]);
		}
	} else {
		this.outletUseByCurrent = false; // allways In use
	}


	if (config["activityTopic"] !== undefined) {
		this.activityTopic = config["activityTopic"];
		this.activityParameter = config["activityParameter"];
	} else {
		this.activityTopic = "";
		this.activityParameter = "";
	}

	this.client_Id = 'mqttjs_' + Math.random().toString(16).substr(2, 8);
	this.options = {
		keepalive: 10,
		clientId: this.client_Id,
		protocolId: 'MQTT',
		protocolVersion: 4,
		clean: true,
		reconnectPeriod: 1000,
		connectTimeout: 30 * 1000,
		will: {
			topic: 'WillMsg',
			payload: 'Connection Closed abnormally..!',
			qos: 0,
			retain: false
		},
		username: config['username'],
		password: config['password'],
		rejectUnauthorized: false
	};


	var EvePowerConsumption = function() {
		Characteristic.call(this, 'Consumption', 'E863F10D-079E-48FF-8F27-9C2605A29F52');
		this.setProps({
			format: Characteristic.Formats.UINT16,
			unit: 'watts',
			maxValue: 1000000000,
			minValue: 0,
			minStep: 1,
			perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
		});
		this.value = this.getDefaultValue();
	};
	inherits(EvePowerConsumption, Characteristic);

	var EvePowerConsumptionVA = function() {
		Characteristic.call(this, 'Consumption VA', 'E863F110-079E-48FF-8F27-9C2605A29F52');
		this.setProps({
			format: Characteristic.Formats.UINT16,
			unit: 'volt-amperes',
			maxValue: 1000000000,
			minValue: 0,
			minStep: 1,
			perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
		});
		this.value = this.getDefaultValue();
	};
	inherits(EvePowerConsumptionVA, Characteristic);


	var EveTotalPowerConsumption = function() {
		Characteristic.call(this, 'Total Consumption', 'E863F10C-079E-48FF-8F27-9C2605A29F52');
		this.setProps({
			format: Characteristic.Formats.FLOAT, // Deviation from Eve Energy observed type
			unit: 'kilowatthours',
			maxValue: 1000000000,
			minValue: 0,
			minStep: 0.001,
			perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
		});
		this.value = this.getDefaultValue();
	};

	inherits(EveTotalPowerConsumption, Characteristic);

	var EveTotalPowerConsumptionVA = function() {
		Characteristic.call(this, 'Total Consumption VA', 'E863F127-079E-48FF-8F27-9C2605A29F52');
		this.setProps({
			format: Characteristic.Formats.FLOAT, // Deviation from Eve Energy observed type
			unit: 'kilovolt-ampereshours',
			maxValue: 1000000000,
			minValue: 0,
			minStep: 0.001,
			perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
		});
		this.value = this.getDefaultValue();
	};

	inherits(EveTotalPowerConsumptionVA, Characteristic);


	var EveVolts = function() {
		Characteristic.call(this, 'Volts', 'E863F10A-079E-48FF-8F27-9C2605A29F52');
		this.setProps({
			format: Characteristic.Formats.UINT16,
			unit: 'volts',
			maxValue: 1000000000,
			minValue: 0,
			minStep: 1,
			perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
		});
		this.value = this.getDefaultValue();
	};

	inherits(EveVolts, Characteristic);

	var EveAmperes = function() {
		Characteristic.call(this, 'Amperes', 'E863F126-079E-48FF-8F27-9C2605A29F52');
		this.setProps({
			format: Characteristic.Formats.UINT16,
			unit: 'amperes',
			maxValue: 1000000000,
			minValue: 0,
			minStep: 0.001,
			perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
		});
		this.value = this.getDefaultValue();
	};

	inherits(EveAmperes, Characteristic);

	this.service = new Service.Outlet(this.options['name']);

	this.service.addOptionalCharacteristic(EvePowerConsumption);
	this.service.addOptionalCharacteristic(EveTotalPowerConsumption);
	this.service.addOptionalCharacteristic(EvePowerConsumptionVA);
	this.service.addOptionalCharacteristic(EveTotalPowerConsumptionVA);
	this.service.addOptionalCharacteristic(EveVolts);
	this.service.addOptionalCharacteristic(EveAmperes);

	if (this.activityTopic !== "") {
		this.service.addOptionalCharacteristic(Characteristic.StatusActive);
		this.service
			.getCharacteristic(Characteristic.StatusActive)
			.on('get', this.getStatusActive.bind(this));
	}

	this.service
		.getCharacteristic(EvePowerConsumption)
		.on('get', this.getPowerConsumption.bind(this));
	this.service
		.getCharacteristic(EvePowerConsumptionVA)
		.on('get', this.getPowerConsumptionVA.bind(this));
	this.service
		.getCharacteristic(EveTotalPowerConsumption)
		.on('get', this.getTotalPowerConsumption.bind(this));
	/*    this.service
	    	.getCharacteristic(EveTotalPowerConsumptionVA)
	    	.on('get', this.getTotalPowerConsumptionVA.bind(this));	*/
	this.service
		.getCharacteristic(EveAmperes)
		.on('get', this.getAmperes.bind(this));
	this.service
		.getCharacteristic(EveVolts)
		.on('get', this.getVolts.bind(this));
	this.service
		.getCharacteristic(Characteristic.On)
		.on('get', this.getStatus.bind(this))
		.on('set', this.setStatus.bind(this));
	this.service
		.getCharacteristic(Characteristic.OutletInUse)
		.on('get', this.getOutletUse.bind(this));

	this.client = mqtt.connect(this.url, this.options);

	var that = this;

	this.client.on('error', function(err) {
		that.log('Error event on MQTT:', err);
	});

	// Eksperyment z wymuszaniem statusu
	this.client.on('connect', function() {
		if (config["startCmd"] !== undefined) {
			that.client.publish(config["startCmd"], config["startParameter"]);
		}
	});

	this.client.on('message', function(topic, message) {

		if (topic == that.topics.energyGet) {
			data = JSON.parse(message);

			if (data === null) {
				return null
			}
			if (data.hasOwnProperty("Power")) {
				that.powerConsumption = parseFloat(data.Power);
				that.service.setCharacteristic(EvePowerConsumption, that.powerConsumption);
			} else {
				return null
			}
			that.lastPeriodNewData = that.lastHourNewData = that.todayNewData = true;
			if (data.hasOwnProperty("Factor")) {
				that.powerFactor = parseFloat(data.Factor);
				that.powerConsumptionAV = that.powerFactor > 0 ? that.powerConsumption / that.powerFactor : 0;
				that.service.setCharacteristic(EvePowerConsumptionVA, that.powerConsumptionAV);
			}
			if (data.hasOwnProperty("Voltage")) {
				that.voltage = parseFloat(data.Voltage);
				that.service.setCharacteristic(EveVolts, that.voltage);
			}
			if (data.hasOwnProperty("Current")) {
				that.amperage = parseFloat(data.Current);
				that.outletNowInUse = that.outletUseByCurrent ? (that.amperage > that.outletInUseCurrent) : true

				that.service.setCharacteristic(EveAmperes, that.amperage);
				that.service.setCharacteristic(Characteristic.OutletInUse, that.outletNowInUse);
			}
			that.todaykWh = data.hasOwnProperty("Today") ? parseFloat(data.Today) : -1;
			// Preserve power data
			if (that.patchToSave) {
				that.fs.readFile(that.patchToSave + that.filename + "_powerTMP.txt", "utf8", function(err, data) {
					if (err) {
						that.lastToSave.lastTimeStamp = new Date().getTime();
						that.fs.writeFile(that.patchToSave + that.filename + "_powerTMP.txt", JSON.stringify(that.lastToSave), "utf8", function(err) {
							if (err) {
								that.log("Problem with save _powerTMP.txt file");
							}
						});
					} else {
						that.lastToSave = JSON.parse(data);
						if (!that.lastToSave.hasOwnProperty("lastTodaykWh") ||
							!that.lastToSave.hasOwnProperty("todaykWh") ||
							!that.lastToSave.hasOwnProperty("totalkWh")) {
							that.lastToSave.lastTimeStamp = new Date().getTime();
							that.fs.writeFile(that.patchToSave + that.filename + "_powerTMP.txt", JSON.stringify(that.lastToSave), "utf8", function(err) {
								if (err) {
									that.log("Problem with save _powerTMP.txt file");
								}
							});
						}
						var deltaPower = 0.0
							//						that.log("Last to save przed manipulacjami: ", that.lastToSave, "LastToday Sonofa: ", that.todaykWh);
						if (that.todaykWh < that.lastToSave.lastTodaykWh) {
							deltaPower = that.todaykWh;
						} else {
							deltaPower = that.todaykWh - that.lastToSave.lastTodaykWh
						}

						that.lastToSave.lastTodaykWh = that.todaykWh;
						that.lastToSave.todaykWh += deltaPower;
						that.lastToSave.totalkWh = that.todaykWhReset ? 0.0 : that.lastToSave.totalkWh + deltaPower;
						that.lastToSave.lastPeriodkWh = that.lastPeriodkWhReset ? 0.0 : that.lastToSave.lastPeriodkWh + deltaPower;
						that.lastToSave.lastHourkWh = that.lastHourkWhReset ? 0.0 : that.lastToSave.lastHourkWh + deltaPower;
						that.lastToSave.lastTimeStamp = new Date().getTime();

						that.todaykWhReset = that.lastPeriodkWhReset = that.lastHourkWhReset = false;

						that.totalPowerConsumption = that.lastToSave.totalkWh;

						that.service.setCharacteristic(EveTotalPowerConsumption, that.totalPowerConsumption);


						that.fs.writeFile(that.patchToSave + that.filename + "_powerTMP.txt", JSON.stringify(that.lastToSave), "utf8", function(err) {
							if (err) {
								that.log("Problem with save _powerTMP.txt file after calculation");
							}
						});

						//						that.log("Last to save po manipulacjach: ", that.lastToSave);
					}
				});
			}
		} else if (topic == that.topicStatusGet) {
			var status = message.toString();
			that.switchStatus = status == that.onValue;
			that.service.getCharacteristic(Characteristic.On).setValue(that.switchStatus, undefined, 'fromSetValue');
		} else if (topic == that.activityTopic) {
			var status = message.toString();
			that.activeStat = status == that.activityParameter;
			that.service.setCharacteristic(Characteristic.StatusActive, that.activeStat);
		} else if (topic == that.topics.stateGet) {
			data = JSON.parse(message);
			if (data.hasOwnProperty("POWER")) {
				var status = data.POWER;
				that.switchStatus = (status == that.onValue);
				that.service.getCharacteristic(Characteristic.On).setValue(that.switchStatus, undefined, '');
			}
		}
	});

	this.client.subscribe(that.topics.energyGet);
	this.client.subscribe(this.topicStatusGet);
	this.client.subscribe(this.topics.stateGet);
	if (this.activityTopic !== "") {
		this.client.subscribe(this.activityTopic);
	}

	// Save data periodically  and reset period data
	var j = schedule.scheduleJob("0 */" + this.savePeriod + " * * * *", function() {
		if (that.savePeriod > 0 && that.lastPeriodNewData) {
			var dataToAppend =
				convertDateUTCDtoLocalStr(new Date(), that.timeOffset) + "\t" +
				that.lastToSave.lastPeriodkWh + "\t" +
				that.powerConsumption + "\t" +
				that.powerConsumptionAV + "\t" +
				that.powerFactor + "\t" +
				that.amperage + "\t" +
				that.voltage + "\n";
			that.fs.appendFile(that.patchToSave + that.filename + "_period_" + that.savePeriod + ".txt", dataToAppend, "utf8", function(err) {
				if (err) {
					that.log("Problem with save periodically", err);
				}
			});
		}
		that.lastPeriodNewData = false;
		that.lastPeriodkWhReset = true;
	});

	// Save data hourly (only if savePeriod < 60)

	var j = schedule.scheduleJob("0 0 * * * *", function() {
		if (that.savePeriod > 0 && that.lastHourNewData) {
			let date = new Date();
			var dataToAppend =
				convertDateUTCDtoLocalStr(date, that.timeOffset) + "\t" +
				that.lastToSave.lastHourkWh + "\t" +
				that.lastToSave.todaykWh + "\t" +
				that.lastToSave.totalkWh + "\t" +
				date.getHours() + "\t" +
				date.getDay() + "\t" +
				date.getDate() + "\n";
			that.fs.appendFile(that.patchToSave + that.filename + "_hourly.txt", dataToAppend, "utf8", function(err) {
				if (err) {
					that.log("Problem with save hourly", err);
				}
			});
		}
		that.lastHourNewData = false;
		that.lastHourkWhReset = true;
	});

	// Save data dayly
	var j = schedule.scheduleJob("0 0 0 * * *", function() {
		if (that.savePeriod > 0 && that.todayNewData) {
			let date = new Date();
			var dataToAppend =
				convertDateUTCDtoLocalStr(new Date(), that.timeOffset) + "\t" +
				that.lastToSave.todaykWh + "\t" +
				that.lastToSave.totalkWh + "\t" +
				date.getDay() + "\t" +
				date.getDate() + "\n";
			that.fs.appendFile(that.patchToSave + that.filename + "_dayly.txt", dataToAppend, "utf8", function(err) {
				if (err) {
					that.log("Problem with save dayly", err);
				}
			});
		}
		that.todayNewData = false;
		that.todaykWhReset = true;
	});
}

// Roll hourly and day files mothly
var j = schedule.scheduleJob("1 0 1 * *", function() {
	that.fs.rename(that.patchToSave + that.filename + "_hourly.txt", that.patchToSave + that.filename + "_hourly_" + convertDateTofilename(data.Time) + ".txt", function(err) {
		if (err) that.log('ERROR change filename: ' + err);
	});
	that.fs.rename(that.patchToSave + that.filename + "_dayly.txt", that.patchToSave + that.filename + "_dayly_" + convertDateTofilename(data.Time) + ".txt", function(err) {
		if (err) that.log('ERROR change filename: ' + err);
	});
});
// Roll periodycally files weekly
var j = schedule.scheduleJob("1 0 * * 1", function() {
	that.fs.rename(that.patchToSave + that.filename + "_period.txt", that.patchToSave + that.filename + "_period_" + convertDateTofilename(data.Time) + ".txt", function(err) {
		if (err) that.log('ERROR change filename: ' + err);
	});
});


// Switch
MqttPowerConsumptionTasmotaAccessory.prototype.getStatus = function(callback) {
	callback(null, this.switchStatus);
}

// Outlet in use
MqttPowerConsumptionTasmotaAccessory.prototype.getOutletUse = function(callback) {
	callback(null, this.outletNowInUse);
}

MqttPowerConsumptionTasmotaAccessory.prototype.setStatus = function(status, callback, context) {
	if (context !== 'fromSetValue') {
		this.switchStatus = status;
		this.client.publish(this.topicStatusSet, status ? this.onValue : this.offValue, this.publish_options);
	}
	callback();
}

// Power - Energy
MqttPowerConsumptionTasmotaAccessory.prototype.getPowerConsumption = function(callback) {
	callback(null, this.powerConsumption);
};

MqttPowerConsumptionTasmotaAccessory.prototype.getTotalPowerConsumption = function(callback) {
	callback(null, this.totalPowerConsumption);
};

MqttPowerConsumptionTasmotaAccessory.prototype.getPowerConsumptionVA = function(callback) {
	callback(null, this.powerConsumptionAV);
};

MqttPowerConsumptionTasmotaAccessory.prototype.getTotalPowerConsumptionVA = function(callback) {
	callback(null, this.totalPowerConsumption);
};

MqttPowerConsumptionTasmotaAccessory.prototype.getVolts = function(callback) {
	callback(null, this.voltage);
};

MqttPowerConsumptionTasmotaAccessory.prototype.getAmperes = function(callback) {
	callback(null, this.amperage);
};

MqttPowerConsumptionTasmotaAccessory.prototype.getStatusActive = function(callback) {
	callback(null, this.activeStat);
}

MqttPowerConsumptionTasmotaAccessory.prototype.getServices = function() {

	var informationService = new Service.AccessoryInformation();

	informationService
		.setCharacteristic(Characteristic.Name, this.name)
		.setCharacteristic(Characteristic.Manufacturer, this.manufacturer)
		.setCharacteristic(Characteristic.Model, this.model)
		.setCharacteristic(Characteristic.SerialNumber, this.serialNumberMAC);

	return [informationService, this.service];
}