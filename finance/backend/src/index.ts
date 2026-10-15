import dotenv from "dotenv";
dotenv.config();

import { createApp } from './app';
import { startD2cTimer } from './services/d2c.service';

const PORT = process.env.PORT || 3100;

createApp().listen(PORT, () => {
    console.log(`Finance API on http://localhost:${PORT}`);
    // F102: the D2C batch checks shipped orders every half hour; it does nothing until switched on.
    startD2cTimer();
});
