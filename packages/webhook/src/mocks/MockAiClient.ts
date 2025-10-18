import type { AiClient, GenerateQuestionInput } from '@myos-quiz/core';
import type { GeneratedQuestion, Choice } from '@myos-quiz/core';

const CHOICES: Choice[] = ['A', 'B', 'C', 'D'];

export class MockAiClient implements AiClient {
  async generateQuestion(input: GenerateQuestionInput): Promise<GeneratedQuestion> {
    const [question, options, correctOption] = this.generateQuestionParts(input);

    return {
      questionId: `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      category: this.pickCategory(input.categories),
      prompt: question,
      options,
      correctOption,
      explanation: 'Mock explanation generated locally without calling OpenAI.'
    };
  }

  private generateQuestionParts(input: GenerateQuestionInput): [string, Record<Choice, string>, Choice] {
    const levelLabels = ['easy', 'medium', 'hard'];
    const difficulty = levelLabels[input.level] ?? 'easy';
    const category = this.pickCategory(input.categories);
    const topic = this.randomTopic();

    const question = `(${difficulty.toUpperCase()}) In the category of ${category}, what is ${topic.subject}?`;
    const baseOptions = this.shuffle([
      topic.correct,
      ...topic.distractors.slice(0, 3)
    ]);

    const options = CHOICES.reduce<Record<Choice, string>>((acc, choice, idx) => {
      acc[choice] = baseOptions[idx] ?? `Option ${choice}`;
      return acc;
    }, { A: '', B: '', C: '', D: '' });

    const correctIndex = baseOptions.indexOf(topic.correct);
    const correctOption = CHOICES[correctIndex] ?? 'A';

    return [question, options, correctOption];
  }

  private pickCategory(categories: string[]): string {
    if (categories?.length) {
      return categories[Math.floor(Math.random() * categories.length)] ?? 'General Knowledge';
    }
    return 'General Knowledge';
  }

  private shuffle<T>(items: T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  private randomTopic(): {
    subject: string;
    correct: string;
    distractors: string[];
  } {
    const topics = [
      {
        subject: 'the capital city of France',
        correct: 'Paris',
        distractors: ['Lyon', 'Marseille', 'Nice']
      },
      {
        subject: 'the chemical symbol for water',
        correct: 'H₂O',
        distractors: ['CO₂', 'O₂', 'NaCl']
      },
      {
        subject: 'the largest planet in our solar system',
        correct: 'Jupiter',
        distractors: ['Saturn', 'Earth', 'Neptune']
      },
      {
        subject: 'the painter of the Mona Lisa',
        correct: 'Leonardo da Vinci',
        distractors: ['Michelangelo', 'Raphael', 'Vincent van Gogh']
      },
      {
        subject: 'the process by which plants make food using sunlight',
        correct: 'Photosynthesis',
        distractors: ['Transpiration', 'Respiration', 'Germination']
      }
    ];

    return topics[Math.floor(Math.random() * topics.length)];
  }
}
