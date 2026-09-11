import { spawn } from 'node:child_process';
spawn(process.execPath,['main.js'],{stdio:'inherit'}).on('exit',code=>process.exit(code??0));
