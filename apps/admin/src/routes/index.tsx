import {createFileRoute} from '@tanstack/react-router';
import {UaiAdmin} from '@uai/admin-module';
import {application} from '../application';
export const Route=createFileRoute('/')({component:()=> <UaiAdmin application={application}/>});
