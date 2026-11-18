import { fireEvent, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { setMediaToken } from '../../api/client';
import { ProjectPageModal } from '../../components/ProjectPageModal';
import { server } from '../mocks/server';
import { render } from '../utils';

it('signs gallery and lightbox images when the modal opens after token sync', async () => {
  const url = '/api/v1/archives/1/project-image/cover.png';
  server.use(http.get('/api/v1/archives/1/project-page', () => HttpResponse.json({
    title: 'Fixture project',
    model_pictures: [{ name: 'Fixture cover', path: 'cover.png', url }],
  })));
  setMediaToken('fixture-media');
  try {
    render(<ProjectPageModal archiveId={1} onClose={() => {}} />);
    const gallery = await screen.findByRole('img', { name: 'Fixture cover' });
    expect(gallery).toHaveAttribute('src', `${url}?token=fixture-media`);
    fireEvent.click(screen.getByRole('button', { name: 'Fixture cover' }));
    const images = screen.getAllByRole('img', { name: 'Fixture cover' });
    expect(images).toHaveLength(2);
    expect(images[1]).toHaveAttribute('src', `${url}?token=fixture-media`);
  } finally {
    setMediaToken(null);
  }
});
