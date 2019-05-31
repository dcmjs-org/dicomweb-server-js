const fs = require('fs-extra');
const path = require('path');
// eslint-disable-next-line import/order
const config = require('./config/index');
// Require the framework and instantiate it
const fastify = require('fastify')({
  logger: config.logger || false,
  https:
    config.https === true &&
    fs.existsSync(path.join(__dirname, 'tls.key')) &&
    fs.existsSync(path.join(__dirname, 'tls.crt'))
      ? {
          key: fs.readFileSync(path.join(__dirname, 'tls.key')),
          cert: fs.readFileSync(path.join(__dirname, 'tls.crt')),
        }
      : '',
});

const atob = require('atob');

// I need to import this after config as it uses config values
const keycloak = require('keycloak-backend')({
  realm: config.authConfig.realm, // required for verify
  'auth-server-url': config.authConfig.authServerUrl, // required for verify
  client_id: config.authConfig.clientId,
  client_secret: config.authConfig.clientSecret,
});

fastify.addContentTypeParser('*', (req, done) => {
  let data = [];
  req.on('data', chunk => {
    data.push(chunk);
  });
  req.on('end', () => {
    data = Buffer.concat(data);
    done(null, data);
  });
});

// require schema jsons
const patientsSchema = require('./config/schemas/patients_output_schema.json');
const studiesSchema = require('./config/schemas/studies_output_schema.json');
const seriesSchema = require('./config/schemas/series_output_schema.json');
const instancesSchema = require('./config/schemas/instances_output_schema.json');

// add schemas to fastify to use by id
fastify.addSchema(patientsSchema);
fastify.addSchema(studiesSchema);
fastify.addSchema(seriesSchema);
fastify.addSchema(instancesSchema);

// enable cors
fastify.register(require('fastify-cors'), {
  origin: '*',
});

// register CouchDB plugin we created
fastify.register(require('./plugins/CouchDB'), {
  url: `${config.dbServer}:${config.dbPort}`,
});

// register routes
// this should be done after CouchDB plugin to be able to use the accessor methods
fastify.register(require('./routes/qido'), { prefix: '/pacs' }); // eslint-disable-line global-require
fastify.register(require('./routes/wado'), { prefix: '/pacs' }); // eslint-disable-line global-require
fastify.register(require('./routes/stow'), { prefix: '/pacs' }); // eslint-disable-line global-require
fastify.register(require('./routes/other'), { prefix: '/pacs' }); // eslint-disable-line global-require

// authCheck routine checks if there is a bearer token or encoded basic authentication
// info in the authorization header and does the authentication or verification of token
// in keycloak
const authCheck = async (authHeader, res) => {
  if (authHeader.startsWith('Bearer ')) {
    // Extract the token
    const token = authHeader.slice(7, authHeader.length);
    fastify.log.info(`Bearer token is ${token}`);
    if (token) {
      // verify token online
      try {
        const verifyToken = await keycloak.jwt.verify(token);
        if (verifyToken.isExpired()) {
          res.code(401).send({
            message: 'Token is expired',
          });
        }
      } catch (e) {
        console.log(e);
        res.code(401).send({
          message: e.message,
        });
      }
    }
  } else if (authHeader.startsWith('Basic ')) {
    // Extract the encoded part
    const authToken = authHeader.slice(6, authHeader.length);
    if (authToken) {
      // Decode and extract username and password
      const auth = atob(authToken);
      const [username, password] = auth.split(':');
      // put the username and password in keycloak object
      keycloak.accessToken.config.username = username;
      keycloak.accessToken.config.password = password;
      try {
        // see if we can authenticate
        // keycloak supports oidc, this is a workaround to support basic authentication
        const accessToken = await keycloak.accessToken.get();
        if (!accessToken) {
          res.code(401).send({
            message: 'Authentication unsuccessful',
          });
        }
      } catch (err) {
        res.code(401).send({
          message: `Authentication error ${err.message}`,
        });
      }
    }
  } else {
    res.code(401).send({
      message: 'Bearer token does not exist',
    });
  }
};

fastify.decorate('auth', async (req, res) => {
  if (config.auth && config.auth !== 'none') {
    // if auth has been given in config, verify authentication
    fastify.log.info('Request needs to be authenticated, checking the authorization header');
    const authHeader = req.headers['x-access-token'] || req.headers.authorization;
    if (authHeader) {
      await authCheck(authHeader, res);
    } else {
      res.code(401).send({
        message: 'Authentication info does not exist or conform with the server',
      });
    }
  }
});

// add authentication prehandler, all requests need to be authenticated
fastify.addHook('preHandler', fastify.auth);

const port = process.env.port || '8090';
const host = process.env.host || '0.0.0.0';
// Run the server!
fastify.listen(port, host);

module.exports = fastify;
