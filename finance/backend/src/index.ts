import dotenv from "dotenv";
dotenv.config();

import { createApp } from './app';

const PORT = process.env.PORT || 3100;

createApp().listen(PORT, () => {
    console.log(`Finance API on http://localhost:${PORT}`);
});
