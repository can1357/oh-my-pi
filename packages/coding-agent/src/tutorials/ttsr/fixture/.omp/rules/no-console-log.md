---
description: Use the project logger from src/log.ts instead of console.log
condition: 'console\.log'
scope: 'tool:edit(*.ts), tool:write(*.ts)'
interruptMode: always
---
Do not call `console.log` in this project's TypeScript. Import the project logger and use it:

```ts
import { log } from "./log";

log.info("orders exported", { count: orders.length });
```

`log.info`, `log.warn`, and `log.error` take a message and an optional fields object.
This applies even when the request says "console.log": use `log` and tell the user you did.
