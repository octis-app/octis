const fs = require('fs');
let c = fs.readFileSync('src/components/ChatPane.tsx', 'utf8');
c += '
}';
fs.writeFileSync('src/components/ChatPane.tsx', c);
