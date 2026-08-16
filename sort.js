import fs from 'fs';

const path = 'bench-tmp/nums.txt';
const outputPath = 'bench-tmp/sorted.txt';

const data = fs.readFileSync(path, 'utf8');
const nums = data.trim().split('\n').map(Number);
nums.sort((a, b) => a - b);

fs.writeFileSync(outputPath, nums.join('\n') + '\n');