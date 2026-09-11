import { createWorker } from 'tesseract.js';
import { readFile } from 'node:fs/promises';
let worker;
async function getWorker(){if(worker)return worker;worker=await createWorker('spa+eng');return worker;}
export async function ocrImage(path){try{const w=await getWorker();const {data}=await w.recognize(path);return data.text||'';}catch(e){console.error('OCR image:',e.message);return '';}}
export async function ocrBase64(base64){const tmp=`./data/media/.ocr-${Date.now()}.jpg`;try{const {writeFile,unlink}=await import('node:fs/promises');await writeFile(tmp,Buffer.from(base64.replace(/^data:[^;]+;base64,/,''),'base64'));const out=await ocrImage(tmp);await unlink(tmp).catch(()=>{});return out;}catch{return '';}}
export async function terminateOCR(){if(worker){await worker.terminate();worker=null;}}
