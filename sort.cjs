const fs = require('fs');
const path = require('path');

const inputPath = path.join(__dirname, 'bench-tmp', 'nums.txt');
const outputPath = path.join(__dirname, 'bench-tmp', 'sorted.txt');

try {
  const data = fs.readFileSync(inputPath, 'utf8');
  const nums = data.trim().split('\n').map(Number);
  nums.sort((a, b) => a - b);
  fs.writeFileSync(outputPath, nums.join('\n') + '\n', 'utf8');
} catch (err) {
  console.error(err);
  process.exit(1);
}