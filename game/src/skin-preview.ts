import { SkinPicker } from './skins';
const picker=new SkinPicker(()=>{},open=>{if(!open)location.href='/';},()=> 'fjord',true);
picker.show();
