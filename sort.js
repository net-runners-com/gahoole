import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const inputPath = path.join(__dirname, 'bench-tmp', 'nums.txt');
const outputPath = path.join(__dirname, 'bench-tmp', 'sorted.txt');

const data = fs.readFileSync(inputPath, 'utf8');
const nums = data.trim().split('\n').map(Number);
nums.sort((a, b) => a - b);

fs.writeFileSync(outputPath, nums.join('\n') + '\n');