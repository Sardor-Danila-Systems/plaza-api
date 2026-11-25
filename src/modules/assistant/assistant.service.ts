import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
  BadGatewayException,
} from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { AppConfigService } from '../../config/app-config.service.js';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.js';
import { CreateFinancialTransactionDto } from '../finances/dto/create-financial-transaction.dto.js';
import { FinancialPostingService } from '../finances/financial-posting.service.js';
import { plainToInstance } from 'class-transformer';
import { signAction, verifyAction } from './action-token.js';
import { AssistantTools, serialize } from './assistant-tools.js';
import { ASSISTANT_SYSTEM_PROMPT } from './assistant.prompt.js';
import type {
  ChatRequestDto,
  ChatResponseDto,
  PendingActionDto,
} from './dto/chat.dto.js';

/** Hard stop for one question, so a confused loop cannot run up a bill. */
const MAX_MODEL_CALLS = 12;

@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);
  private client: Anthropic | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly tools: AssistantTools,
    private readonly finances: FinancialPostingService,
  ) {}

  private anthropic(): Anthropic {
    const apiKey = this.config.anthropicApiKey;
    if (!apiKey) {
      throw new ServiceUnavailableException({
        code: 'ASSISTANT_DISABLED',
        message: 'ANTHROPIC_API_KEY is not configured',
      });
    }
    this.client ??= new Anthropic({ apiKey });
    return this.client;
  }

  async chat(
    user: AuthenticatedUser,
    dto: ChatRequestDto,
  ): Promise<ChatResponseDto> {
    const last = dto.messages[dto.messages.length - 1];
    if (last.role !== 'user') {
      throw new UnprocessableEntityException({
        code: 'VALIDATION_ERROR',
        message: 'The last message must be the user question',
      });
    }

    const client = this.anthropic();
    const tools = this.tools.definitions(user);
    const messages: Anthropic.Beta.BetaMessageParam[] = dto.messages.map(
      (m) => ({
        role: m.role,
        content: m.text,
      }),
    );
    // Per-request facts go in a mid-conversation system message, after the
    // question, so the system prompt and tools stay a stable cached prefix.
    messages.push({
      role: 'system',
      content: this.contextNote(user, dto.currentProjectId),
    });

    const pendingActions: PendingActionDto[] = [];
    const toolsUsed: string[] = [];

    for (let call = 0; call < MAX_MODEL_CALLS; call++) {
      const response = await this.callModel(client, tools, messages);
      messages.push({ role: 'assistant', content: response.content });

      if (response.stop_reason === 'refusal') {
        return {
          reply: 'Я не могу помочь с этим запросом.',
          pendingActions,
          toolsUsed,
        };
      }
      const toolUses = response.content.filter(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use',
      );
      if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
        const reply = response.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        const cut =
          response.stop_reason === 'max_tokens' ? '\n\n(ответ обрезан)' : '';
        return { reply: reply + cut, pendingActions, toolsUsed };
      }

      // Parallel calls: run them together, answer them in one user message.
      const results = await Promise.all(
        toolUses.map(async (use) => {
          toolsUsed.push(use.name);
          const outcome = await this.tools.run(user, use.name, use.input);
          if (outcome.proposal) {
            const { action, token } = signAction(
              { ...outcome.proposal, userId: user.id },
              this.config.jwtAccessSecret,
            );
            pendingActions.push({
              id: action.id,
              kind: action.kind,
              projectId: action.projectId,
              payload: action.payload,
              summary: outcome.proposal.summary,
              token,
              expiresAt: new Date(action.expiresAt).toISOString(),
            });
          }
          return {
            type: 'tool_result' as const,
            tool_use_id: use.id,
            content: outcome.content,
            is_error: outcome.isError,
          };
        }),
      );
      messages.push({ role: 'user', content: results });
    }

    return {
      reply: 'Вопрос потребовал слишком много шагов. Уточните его, пожалуйста.',
      pendingActions,
      toolsUsed,
    };
  }

  private async callModel(
    client: Anthropic,
    tools: Anthropic.Tool[],
    messages: Anthropic.Beta.BetaMessageParam[],
  ): Promise<Anthropic.Beta.BetaMessage> {
    try {
      return await client.beta.messages.create({
        model: this.config.assistantModel,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        cache_control: { type: 'ephemeral' },
        system: ASSISTANT_SYSTEM_PROMPT,
        tools,
        messages,
      });
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) {
        throw new ServiceUnavailableException({
          code: 'ASSISTANT_BUSY',
          message: 'Ассистент перегружен, попробуйте через минуту',
        });
      }
      if (error instanceof Anthropic.APIError) {
        this.logger.error(
          `Claude API ${String(error.status)}: ${error.message}`,
        );
        throw new BadGatewayException({
          code: 'ASSISTANT_UPSTREAM_ERROR',
          message: 'Ассистент временно недоступен',
        });
      }
      throw error;
    }
  }

  private contextNote(
    user: AuthenticatedUser,
    currentProjectId?: string,
  ): string {
    const today = new Date().toISOString().slice(0, 10);
    return [
      `Сегодня ${today}.`,
      `Пользователь: ${user.displayName}, роль ${user.role}.`,
      currentProjectId
        ? `В интерфейсе открыт проект ${currentProjectId}; «этот проект» значит его.`
        : 'Конкретный проект в интерфейсе не выбран.',
    ].join(' ');
  }

  /** Executes a write the owner confirmed. Permissions are checked again, as the current user. */
  async confirm(
    user: AuthenticatedUser,
    token: string,
    requestId?: string,
  ): Promise<unknown> {
    const action = verifyAction(token, this.config.jwtAccessSecret);
    if (!action || action.userId !== user.id) {
      throw new UnprocessableEntityException({
        code: 'ASSISTANT_ACTION_INVALID',
        message:
          'Предложение недействительно или истекло — попросите ассистента снова',
      });
    }
    const dto = plainToInstance(CreateFinancialTransactionDto, action.payload);
    const result = await this.finances.create(
      user,
      action.projectId,
      dto,
      action.id,
      requestId,
    );
    return JSON.parse(serialize(result.transaction)) as unknown;
  }
}
