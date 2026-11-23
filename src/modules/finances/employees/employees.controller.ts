import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import {
  CreateEmployeeDto,
  EmployeeLedgerResponseDto,
  EmployeeResponseDto,
  OpenAdvanceDto,
  UpdateEmployeeDto,
} from './dto/employee.dto.js';
import { EmployeesService } from './employees.service.js';

@ApiTags('finances')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/employees')
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  @ApiOperation({
    summary: 'Employees with outstanding salary-advance balances',
  })
  @ApiOkResponse({ type: [EmployeeResponseDto] })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ): Promise<EmployeeResponseDto[]> {
    return this.employees.list(user, projectId);
  }

  @Post()
  @ApiOperation({ summary: 'Add an employee' })
  @ApiCreatedResponse({ type: EmployeeResponseDto })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateEmployeeDto,
  ): Promise<EmployeeResponseDto> {
    return this.employees.create(user, projectId, dto);
  }

  @Patch(':employeeId')
  @ApiOperation({ summary: 'Rename or deactivate/restore an employee' })
  @ApiOkResponse({ type: EmployeeResponseDto })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Body() dto: UpdateEmployeeDto,
  ): Promise<EmployeeResponseDto> {
    return this.employees.update(user, projectId, employeeId, dto);
  }

  @Get(':employeeId/open-advances')
  @ApiOperation({
    summary: 'Advances not yet fully deducted (for the payout form)',
  })
  @ApiOkResponse({ type: [OpenAdvanceDto] })
  openAdvances(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
  ): Promise<OpenAdvanceDto[]> {
    return this.employees.openAdvances(user, projectId, employeeId);
  }

  @Get(':employeeId/ledger')
  @ApiOperation({ summary: 'Advances, payouts and deductions of one employee' })
  @ApiOkResponse({ type: EmployeeLedgerResponseDto })
  ledger(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
  ): Promise<EmployeeLedgerResponseDto> {
    return this.employees.ledger(user, projectId, employeeId);
  }
}
