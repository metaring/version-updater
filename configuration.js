var configuration = require('./configuration.json');

var configurationLocal = {};

try {
    configurationLocal = require('./configuration.local.json');
} catch(e) {
}

Object.keys(configurationLocal).map(it => configuration[it] = configurationLocal[it]);

module.exports = configuration;