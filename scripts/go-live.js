'use strict';
// Runs the game server and opens a free public HTTPS tunnel (localhost.run over SSH),
// so friends anywhere can join. No account or install needed, just OpenSSH, which ships
// with Windows 10/11 and macOS. Keep this window open while you play.
//
//   npm run live

const { spawn } = require('child_process');

const PORT = process.env.PORT || '3000';
process.env.PORT = PORT;
require('../server');

let lastUrl = null;

function openTunnel() {
  const ssh = spawn('ssh', [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ExitOnForwardFailure=yes',
    '-R', `80:localhost:${PORT}`,
    'nokey@localhost.run',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const scan = (buf) => {
    // Only the tunnel's own lhr.life address; the banner also mentions admin.localhost.run.
    const match = String(buf).match(/https:\/\/[a-z0-9-]+\.lhr\.life/i);
    if (match && match[0] !== lastUrl) {
      lastUrl = match[0];
      console.log('\n==============================================');
      console.log(' Inside Job is LIVE. Send your friends this link:');
      console.log(`   ${lastUrl}`);
      console.log('==============================================\n');
    }
  };
  ssh.stdout.on('data', scan);
  ssh.stderr.on('data', scan);
  ssh.on('exit', (code) => {
    console.log(`Tunnel closed (code ${code}). Reconnecting in 5 seconds… (the link may change)`);
    setTimeout(openTunnel, 5000);
  });
}

openTunnel();
