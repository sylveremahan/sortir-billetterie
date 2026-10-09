import crypto from 'node:crypto';
import readline from 'node:readline';

if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
  console.error('Run this command in an interactive terminal so the password is not echoed.');
  process.exit(1);
}

readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdout.write('Mot de passe (14 caractères minimum, saisie masquée) : ');
let password = '';
process.stdin.on('keypress', (character, key = {}) => {
  if (key.ctrl && key.name === 'c') {
    process.stdout.write('\n');
    process.exit(130);
  }
  if (key.name === 'return' || key.name === 'enter') {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\n');
    if (password.length < 14) {
      console.error('Le mot de passe doit contenir au moins 14 caractères.');
      process.exitCode = 1;
      return;
    }
    const salt = crypto.randomBytes(16);
    const keyBytes = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    console.log(`scrypt$16384$8$1$${salt.toString('base64url')}$${keyBytes.toString('base64url')}`);
    password = '';
    return;
  }
  if (key.name === 'backspace') {
    password = password.slice(0, -1);
    return;
  }
  if (character && !key.ctrl && !key.meta) password += character;
});
