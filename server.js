const express = require('express');
const bodyParser = require('body-parser');
const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const Influx = require('influx');
const ejs = require('ejs');
const moment = require('moment'); // Import moment library

const app = express();
const port = 6789;

// Middleware setup
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');

// Read configuration
const configPath = '/data/options.json';
let config;
try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (error) {
    console.error('Error reading configuration file:', error);
    process.exit(1);
}

// InfluxDB configuration
const influxConfig = {
    host: '192.168.160.55',
    port: 8086,
    database: 'solarassistant',
    username: 'admin',
    password: 'adminadmin',
};
const influx = new Influx.InfluxDB(influxConfig);

// MQTT configuration
const mqttConfig = {
    host: config.mqtt_ip,
    port: config.mqtt_port,
    username: config.mqtt_username,
    password: config.mqtt_password,
};
let mqttClient;
let incomingMessages = [];

// Connect to MQTT broker
function connectToMqtt() {
    mqttClient = mqtt.connect(`mqtt://${mqttConfig.host}:${mqttConfig.port}`, {
        username: mqttConfig.username,
        password: mqttConfig.password,
    });

    mqttClient.on('connect', () => {
        console.log('Connected to MQTT broker');
        mqttClient.subscribe('solar_assistant_DEYE/#');
    });

    mqttClient.on('message', (topic, message) => {
        const formattedMessage = `${topic}: ${message.toString()}`;
        incomingMessages.push(formattedMessage);
        saveMessageToInfluxDB(topic, message);
    });

    mqttClient.on('error', (err) => {
        console.error('Error connecting to MQTT broker:', err.message);
        mqttClient = null;
    });
}

// Save MQTT message to InfluxDB
function saveMessageToInfluxDB(topic, message) {
    const parsedMessage = parseFloat(message.toString());
    if (isNaN(parsedMessage)) return;

    const timestamp = new Date().getTime();
    const dataPoint = {
        measurement: 'state',
        fields: { value: parsedMessage },
        tags: { topic },
        timestamp: timestamp * 1000000,
    };

    influx.writePoints([dataPoint])
        .catch((err) => {
            console.error('Error saving message to InfluxDB:', err.toString());
        });
}


// Fetch current value from InfluxDB
async function getCurrentValue(topic) {
    const query = `
        SELECT mean("value") AS "value"
        FROM "state"
        WHERE "topic" = '${topic}'
        AND time >= now() - 2d
        GROUP BY time(1d) tz('Indian/Mauritius')
    `;
    try {
        return await influx.query(query);
    } catch (error) {
        console.error(`Error querying InfluxDB for topic ${topic}:`, error.toString());
        throw error;
    }
}

async function getCurrentData(topic) {
    const query = `
        SELECT last("value") AS "value"
        FROM "state"
        WHERE "topic" = '${topic}'
        ORDER BY time DESC
        LIMIT 1
    `;

    try {
        const result = await influx.query(query);
        return result[0];
    } catch (error) {
        console.error(`Error querying InfluxDB for topic ${topic}:`, error);
        throw error;
    }
}

// Fetch analytics data from InfluxDB
async function queryInfluxDB(topic) {
    const query = `
        SELECT mean("value") AS "value"
        FROM "state"
        WHERE "topic" = '${topic}'
        AND time >= now() - 30d
        GROUP BY time(1d) tz('Indian/Mauritius')
    `;
    try {
        return await influx.query(query);
    } catch (error) {
        console.error(`Error querying InfluxDB for topic ${topic}:`, error.toString());
        throw error;
    }
}

// Calculate daily difference
function calculateDailyDifference(data) {
    return data.map((current, index, array) => {
        if (index === 0 || !array[index - 1].value) {
            return { ...current, value: 0 };
        } else {
            const previousData = array[index - 1].value;
            const currentData = current.value;
            return currentData >= previousData
                ? { ...current, value: currentData - previousData }
                : { ...current };
        }
    });
}

// Route handlers
app.get('/automation', (req, res) => res.sendFile(path.join(__dirname, 'public', 'automation.html')));
app.get('/configuration', (req, res) => res.sendFile(path.join(__dirname, 'public', 'configuration.html')));
app.get('/charts', (req, res) => res.sendFile(path.join(__dirname, 'public', 'charts.html')));
app.get('/messages', (req, res) => res.sendFile(path.join(__dirname, 'public', 'messages.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

app.get('/api/messages', (req, res) => {
    const categoryFilter = req.query.category;
    const filteredMessages = filterMessagesByCategory(categoryFilter);
    res.json(filteredMessages);
});

app.get('/api/energy', async (req, res) => {
    try {
        const loadPowerData = await getCurrentValue('solar_assistant_DEYE/total/load_energy/state');
        const pvPowerData = await getCurrentValue('solar_assistant_DEYE/total/pv_energy/state');
        const batteryPowerInData = await getCurrentValue('solar_assistant_DEYE/total/battery_energy_in/state');
        const batteryPowerOutData = await getCurrentValue('solar_assistant_DEYE/total/battery_energy_out/state');
        const gridPowerInData = await getCurrentValue('solar_assistant_DEYE/total/grid_energy_in/state');
        const gridPowerOutData = await getCurrentValue('solar_assistant_DEYE/total/grid_energy_out/state');

        const loadPowerDataDaily = calculateDailyDifference(loadPowerData);
        const pvPowerDataDaily = calculateDailyDifference(pvPowerData);
        const batteryPowerInDataDaily = calculateDailyDifference(batteryPowerInData);
        const batteryPowerOutDataDaily = calculateDailyDifference(batteryPowerOutData);
        const gridPowerInDataDaily = calculateDailyDifference(gridPowerInData);
        const gridPowerOutDataDaily = calculateDailyDifference(gridPowerOutData);

        const hourlyData = loadPowerDataDaily.map((load, index) => ({
            hour: moment(load.time).format('HH'), // Use moment library
            load: load.value || 0,
            solar: (pvPowerDataDaily[index] && pvPowerDataDaily[index].value) || 0,
            battery: (batteryPowerOutDataDaily[index] && batteryPowerOutDataDaily[index].value) || 0,
            grid: (gridPowerInDataDaily[index] && gridPowerInDataDaily[index].value) || 0
        }));

        const data = {
            totalConsumption: loadPowerDataDaily.reduce((acc, load) => acc + (load.value || 0), 0),
            solarProduction: pvPowerDataDaily.reduce((acc, pv) => acc + (pv.value || 0), 0),
            gridIn: gridPowerInDataDaily.reduce((acc, grid) => acc + Math.max(grid.value || 0, 0), 0),gridOut: gridPowerOutDataDaily.reduce((acc, grid) => acc + Math.min(grid.value || 0, 0), 0),
            batteryCharged: batteryPowerInDataDaily.reduce((acc, battery) => acc + Math.max(battery.value || 0, 0), 0),
            batteryDischarged: batteryPowerOutDataDaily.reduce((acc, battery) => acc + Math.min(battery.value || 0, 0), 0),
            hourlyData
        };

        res.json(data);
    } catch (error) {
        console.error('Error fetching energy data:', error);
        res.status(500).send('Error fetching energy data');
    }
});

app.get('/analytics', async (req, res) => {
    try {
        const loadPowerData = await queryInfluxDB('solar_assistant_DEYE/total/load_energy/state');
        const pvPowerData = await queryInfluxDB('solar_assistant_DEYE/total/pv_energy/state');
        const batteryStateOfChargeData = await queryInfluxDB('solar_assistant_DEYE/total/battery_energy_in/state');
        const batteryPowerData = await queryInfluxDB('solar_assistant_DEYE/total/battery_energy_out/state');
        const gridPowerData = await queryInfluxDB('solar_assistant_DEYE/total/grid_energy_in/state');
        const gridVoltageData = await queryInfluxDB('solar_assistant_DEYE/total/grid_energy_out/state');

        const data = {
            loadPowerData,
            pvPowerData,
            batteryStateOfChargeData,
            batteryPowerData,
            gridPowerData,
            gridVoltageData,
        };

        res.render('analytics', { data });
    } catch (error) {
        console.error('Error fetching analytics data from InfluxDB:', error);
        res.status(500).send('Error fetching analytics data from InfluxDB');
    }
});



app.get('/', async (req, res) => {
    try {

        const loadPower = await getCurrentData('solar_assistant_DEYE/total/load_power/state');
        const solarProduction = await getCurrentData('solar_assistant_DEYE/total/pv_power/state');
        const batteryStateOfCharge = await getCurrentData('solar_assistant_DEYE/total/battery_state_of_charge/state');
        const gridImport = await getCurrentData('solar_assistant_DEYE/total/grid_power/state');
        const gridVoltage = await getCurrentData('solar_assistant_DEYE/total/grid_voltage/state');


        const data = {
          
            loadPower,
            solarProduction,
            batteryStateOfCharge,
            gridImport,
            gridVoltage,
    
        };

        res.render('energy-dashboard', { data });
    } catch (error) {
        console.error('Error fetching data from InfluxDB:', error);
        res.status(500).send('Error fetching data from InfluxDB');
    }
});

app.get('/api/realtime-data', async (req, res) => {
    try {
        const loadPower = await getCurrentData('solar_assistant_DEYE/total/load_power/state');
        const solarProduction = await getCurrentData('solar_assistant_DEYE/total/pv_power/state');
        const batteryStateOfCharge = await getCurrentData('solar_assistant_DEYE/total/battery_state_of_charge/state');
        const gridImport = await getCurrentData('solar_assistant_DEYE/total/grid_power/state');
        const gridVoltage = await getCurrentData('solar_assistant_DEYE/total/grid_voltage/state');

        const data = {
            loadPower,
            solarProduction,
            batteryStateOfCharge,
            gridImport,
            gridVoltage,
        };

        res.json(data);
    } catch (error) {
        console.error('Error fetching real-time data:', error);
        res.status(500).send('Error fetching real-time data');
    }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Server is running on http://0.0.0.0:${port}`);
    connectToMqtt();
});

function filterMessagesByCategory(category) {
    if (category && category !== 'all') {
        return incomingMessages.filter(message => {
            const keywords = getCategoryKeywords(category);
            return keywords.some(keyword => message.includes(keyword));
        });
    }
    return incomingMessages;
}

function getCategoryKeywords(category) {
    switch (category) {
        case 'inverter1':
            return ['inverter_1'];
        case 'inverter2':
            return ['inverter_2'];
        case 'loadPower':
            return ['load_power'];
        case 'gridPower':
            return ['grid_power'];
        default:
            return [];
    }
}
