/**
 * Kept in its own module so App can probe for the model without importing
 * GltfRobot — importing that module pulls in the GLTF loader and, previously,
 * kicked off a load for a file that may not exist yet.
 */
export const MODEL_URL = '/models/enubot.glb'
