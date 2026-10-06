import { Request, Response, NextFunction } from 'express';
import { authService } from '../services/auth.service.js';
import { z } from 'zod';
import { ValidationError } from '../errors/index.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6, 'La contraseña debe tener al menos 6 caracteres'),
});

export class AuthController {
  async login(req: Request, res: Response, next: NextFunction) {
    try {
      const data = loginSchema.parse(req.body);
      const result = await authService.login(data.email, data.password);
      res.json(result);
    } catch (error) {
      next(error instanceof z.ZodError ? new ValidationError('Datos inválidos', (error as any).issues) : error);
    }
  }

  async register(req: Request, res: Response, next: NextFunction) {
    try {
      const data = registerSchema.parse(req.body);
      const result = await authService.register(data);
      res.status(201).json(result);
    } catch (error) {
      next(error instanceof z.ZodError ? new ValidationError('Datos inválidos', (error as any).issues) : error);
    }
  }

  async me(req: Request, res: Response, next: NextFunction) {
    try {
      const user = await authService.getMe(req.ctx!.userId);
      res.json({ user });
    } catch (error) {
      next(error);
    }
  }
}

export const authController = new AuthController();
