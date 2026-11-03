import 'dotenv/config'

const ensureValue = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

export const JWT_SECRET = ensureValue('JWT_SECRET', 'local-development-secret-change-before-deploy')
export const CLIENT_URL = ensureValue('CLIENT_URL', 'http://localhost:5173')
export const DATABASE_URL = ensureValue('DATABASE_URL', 'file:./dev.db')
