import fs from 'fs';

try {
  const data = fs.readFileSync('bench-tmp/nums.txt', 'utf8');
  const numbers = data.trim().split('\n').map(Number);
  numbers.sort((a, b) => a - b);
  fs.writeFileSync('bench-tmp/sorted.txt', numbers.join('\n') + '\n');
} catch (err) {
  console.error(err);
  process.exit(1);
}