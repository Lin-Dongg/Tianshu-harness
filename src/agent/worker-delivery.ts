import { z } from 'zod'
export const workerDeliverySchema = z.enum(['diagnosis', 'patch', 'verification'])
export type WorkerDelivery = z.infer<typeof workerDeliverySchema>
