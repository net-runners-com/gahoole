import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const inputPath = path.join(__dirname, 'bench-tmp', 'nums.txt');
const outputPath = path.join(__dirname, 'bench-tmp', 'sorted.txt');

try {
  const data = fs.readFileSync(inputPath, 'utf8');
  const numbers = data.trim().split(/\r?\n/).map(Number);
  numbers.sort((a, b) => a - b);
  fs.writeFileSync(outputPath, numbers.join('\n') + '\n', 'utf8');
} catch (err) {
  console.error(err);
  process.exit(1);
}