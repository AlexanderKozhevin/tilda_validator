import fs from 'fs/promises';
import Redis from 'ioredis';

const REDIS_HOST = process.env.REDIS_HOST;
const REDIS_PORT = process.env.REDIS_PORT;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;

process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";

let redisClientNew;
const redisReadyPromise = new Promise((resolve, reject) => {
    async function init() {

        redisClientNew = new Redis("redis://default:s9dh38vnsdKJ293r02msdTksmnp@45.147.162.224:16379");

        redisClientNew.on('connect', () => {
            console.log('Connected to Redis.');
            resolve();  // Resolve the promise when Redis connects
        });

        redisClientNew.on('error', (err) => {
            console.error('Error connecting to Redis:', err);
            reject(err);  // Reject the promise on error
        });
    }

    init();
});

const promisedRedis = {
    get: async (key) => redisClientNew.get(key),
    set: async (key, value) => redisClientNew.set(key, value),
    del: async (key) => redisClientNew.del(key),
    inc: async (key) => redisClientNew.incr(key)
};

export { redisClientNew as client, promisedRedis as methods, redisReadyPromise };