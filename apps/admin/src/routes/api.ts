import {createFileRoute} from '@tanstack/react-router';
import {handle} from '../server/backend';
export const Route=createFileRoute('/api')({server:{handlers:{GET:({request})=>handle(request),POST:({request})=>handle(request)}}});
