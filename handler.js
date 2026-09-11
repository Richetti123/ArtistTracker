import { answerInterest } from './lib/tracker.js';
export async function handleMessage(sock,msg){if(!msg?.message||msg.key?.fromMe)return;await answerInterest(sock,msg);}
