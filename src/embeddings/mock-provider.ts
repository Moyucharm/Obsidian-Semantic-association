import type { Vector } from "../types";
import type { EmbeddingProvider } from "./provider";

const MOCK_DIMENSION = 128;

export class MockProvider implements EmbeddingProvider {
	readonly name = "mock";
	readonly dimension = MOCK_DIMENSION;

	async embed(text: string): Promise<Vector> {
		return this.generateVector(text);
	}

	async embedBatch(texts: string[]): Promise<Vector[]> {
		return texts.map((text) => this.generateVector(text));
	}

	private generateVector(text: string): Vector {
		const vector = new Array<number>(MOCK_DIMENSION).fill(0);
		if (!text) {
			return vector;
		}

		for (let i = 0; i < text.length; i++) {
			const slot = text.charCodeAt(i) % MOCK_DIMENSION;
			vector[slot] += 1;
		}

		const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
		if (norm > 0) {
			for (let i = 0; i < vector.length; i++) {
				vector[i] /= norm;
			}
		}

		return vector;
	}
}
