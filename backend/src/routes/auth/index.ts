import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { auth } from '../../middlewares/auth.js';
import { authController } from '../../controllers/auth.controller.js';

const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { error: { code: 'RATE_LIMIT', message: 'Too many requests, try again later' } },
});

const meLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: { code: 'RATE_LIMIT', message: 'Too many requests, try again later' } },
});

const router = Router();

router.get('/me', meLimiter, auth, (req, res, next) => authController.me(req, res, next));

router.use(strictLimiter);

router.post('/login', (req, res, next) => authController.login(req, res, next));
router.post('/register', (req, res, next) => authController.register(req, res, next));

export default router;
