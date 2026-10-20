import type { Project, LLMProvider } from '../../../types/app';

type ChatReference = {
  origin: string;
  project: Pick<Project, 'projectId' | 'fullPath'>;
  sessionId: string;
  provider: LLMProvider;
  providerSessionId: string | null;
};

export function formatChatReference({ origin, project, sessionId, provider, providerSessionId }: ChatReference): string {
  return [
    `Чат на сервере: ${origin}`,
    `ID чата: ${sessionId}`,
    `Нейросеть: ${provider}`,
    ...(providerSessionId ? [`ID сессии ${provider}: ${providerSessionId}`] : []),
    `Проект: ${project.fullPath}`,
    `ID проекта: ${project.projectId}`,
    'Для поиска разговора используй полный ID чата (sessions.session_id) на указанном сервере; ID сессии относится к указанной нейросети.',
  ].join('\n');
}
