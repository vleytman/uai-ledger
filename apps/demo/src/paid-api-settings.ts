export const paidApiScenarios = [
 {operation:'scrape',label:'Прочитать страницу',field:'URL страницы',example:'https://example.com',hint:'Текст страницы в Markdown. Обычно 1 credit Firecrawl.'},
 {operation:'search',label:'Поиск в интернете',field:'Поисковый запрос',example:'site:uspto.gov patent search',hint:'Один результат без дополнительного чтения страниц. Обычно 2 credits Firecrawl.'},
 {operation:'patent_search',label:'Поиск патентов',field:'Запрос USPTO',example:'"quantum computing".ti.',hint:'Поиск по названию патента. Один результат. Обычно 5 credits Firecrawl.'},
 {operation:'patent_document',label:'Патент по номеру',field:'Номер патента',example:'11234567',hint:'Библиографические данные патента. Обычно 5 credits Firecrawl.'},
] as const;
export function paidApiInput(operation:string,value:string):Record<string,unknown>{
 const text=value.trim();if(!text)throw new Error('Заполните поле запроса.');
 switch(operation){
  case 'scrape':return {url:text,formats:['markdown']};
  case 'search':return {query:text,limit:1,scrape:false};
  case 'patent_search':return {query:text,page_size:1,start:0};
  case 'patent_document':return {number:text,include_full_text:false};
  default:throw new Error('Неизвестная API-операция.');
 }
}
