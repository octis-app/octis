module.exports = {
  apps: [{
    name: 'octis-server',
    script: 'server/index.js',
    cwd: '/opt/octis',
    env: {
      NODE_ENV: 'production',
      GATEWAY_TOKEN: 'e9a2d458e909d3db75ef2e787ceb7f6022df91e936d06f14',
      GATEWAY_URL: '/gateway',
      COSTS_DB_URL: 'postgresql://casken_app:MrS%23qT99V45N6gBGDNMW2%23LENxWq@127.0.0.1:15432/casken',
      COSTS_USER_ID: 'kennan'
    }
  }]
}
